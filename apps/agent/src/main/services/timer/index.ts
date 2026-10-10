import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { app, net } from 'electron';
import path from 'node:path';
import { TimerService } from './timerService';
import { SqliteEntryStore } from './sqliteStore';
import { SqliteTodayLedgerStore } from './todayLedgerStore';
import { HttpSyncClient } from './syncClient';
import { TimerSyncDrain, type TimerSyncDrainReason } from './syncDrain';
import type { Clock, IdGen, MissedSleep } from './types';
import { log } from '../../logger';
import { getTrackingReadinessService } from '../trackingReadiness';
import { getWorkspaceTimeContext } from '../workspaceTime';
import { loadTokens } from '../tokenStore';
import type { TimerOwner, TimerRecoveryResult } from './types';
import { setPreferencesOwner } from '../preferences';
import { TodayLedgerHydrator, type TodayLedgerRefreshReason } from './todayLedgerHydrator';
import { api } from '../apiClient';
import { broadcast } from '../../broadcast';
import { serverAlignedNow } from '../serverClock';
import { getTodayLedgerMode } from '../agentConfig';
import type { TodayLedgerMode } from '@grind/types';

// Server-aligned: timer timestamps are validated (and clamped) by the server,
// so they must be stamped in the server's frame rather than the laptop's.
// The raw device readings are only ever compared with each other (the gap
// between two proofs of life), never stamped on anything.
const realClock: Clock = {
  now: () => serverAlignedNow(),
  // eslint-disable-next-line no-restricted-syntax -- device<->device: only the gap between two readings is used
  wallNow: () => Date.now(),
  monoNow: () => performance.now(),
};
const realIds: IdGen = { ulid: () => ulid() };

let service: TimerService | null = null;
let syncDrain: TimerSyncDrain | null = null;
let todayLedgerStore: SqliteTodayLedgerStore | null = null;
let todayLedgerHydrator: TodayLedgerHydrator | null = null;
let configuredTodayLedgerMode: TodayLedgerMode | null = null;
let timerRuntimeStarted = false;
let missedSleepListener: ((missed: MissedSleep) => void) | null = null;

/**
 * Who handles a sleep the OS never reported (see TimerService.noteAlive).
 * Registered without building the service, so wiring it never opens the DB
 * ahead of boot.
 */
export function onTimerMissedSleep(listener: (missed: MissedSleep) => void): void {
  missedSleepListener = listener;
}

/** Lazily build the timer service against the on-disk SQLite DB. */
export function getTimerService(): TimerService {
  if (service) return service;
  const dbPath = path.join(app.getPath('userData'), 'agent.db');
  const db = new Database(dbPath);
  const store = new SqliteEntryStore(db);
  todayLedgerStore = new SqliteTodayLedgerStore(db);
  service = new TimerService(
    store,
    new HttpSyncClient(),
    realClock,
    realIds,
    getTrackingReadinessService(),
    {
      window(now) {
        const context = getWorkspaceTimeContext(now);
        return context.ready && context.dayStart !== null && context.dayEnd !== null
          ? { start: context.dayStart, end: context.dayEnd }
          : null;
      },
    },
    todayLedgerStore,
  );
  service.setTodayLedgerMode(configuredTodayLedgerMode ?? getTodayLedgerMode());
  service.setMissedSleepListener((missed) => missedSleepListener?.(missed));
  log.info('timer service initialized', { dbPath });
  return service;
}

export function getTodayLedgerStore(): SqliteTodayLedgerStore {
  getTimerService();
  if (!todayLedgerStore) throw new Error('today_ledger_store_unavailable');
  return todayLedgerStore;
}

function getTodayLedgerHydrator(): TodayLedgerHydrator {
  if (todayLedgerHydrator) return todayLedgerHydrator;
  const timer = getTimerService();
  todayLedgerHydrator = new TodayLedgerHydrator({
    timer,
    cache: getTodayLedgerStore(),
    getMode: () => configuredTodayLedgerMode ?? getTodayLedgerMode(),
    loadTokens,
    getWindow: () => {
      const context = getWorkspaceTimeContext();
      return context.ready && context.dayStart !== null && context.dayEnd !== null
        ? { start: context.dayStart, end: context.dayEnd }
        : null;
    },
    fetchSnapshot: (requestPath) => api<unknown>(requestPath, { timeoutMs: 20_000 }),
    onUpdated: () => broadcast('timer:status:push', timer.status()),
    log,
  });
  timer.setMutationListener(() => void todayLedgerHydrator?.refresh('mutation'));
  return todayLedgerHydrator;
}

function ownerFromTokens(tokens: Awaited<ReturnType<typeof loadTokens>>): TimerOwner | null {
  return tokens ? { userId: tokens.userId, workspaceId: tokens.workspaceId } : null;
}

function logRecovered(recovered: TimerRecoveryResult[], context: string): void {
  for (const item of recovered) {
    log.warn('timer recovered stale open entry', {
      context,
      entryId: item.entryId,
      recoveredAt: item.recoveredAt,
      reason: item.notice.reason,
    });
  }
}

/**
 * Point the timer, and the per-account preferences, at `owner`. Any entry left
 * open on either side of an owner change is closed at its last proof of life
 * first (see TimerService.switchOwner).
 */
function bindOwner(owner: TimerOwner | null, claimLegacy: boolean, context: string): void {
  const recovered = getTimerService().switchOwner(owner, claimLegacy);
  setPreferencesOwner(owner, { claimLegacy });
  logRecovered(recovered, context);
}

/**
 * Recover any left-open entry on boot.
 *
 * Deliberately does NOT flush the sync backlog. `flushUnsynced` walks every
 * pending entry with one awaited round-trip each and no upper bound, so a user
 * who was offline or signed out for a while came back to a boot that blocked on
 * hundreds of sequential requests — the app looked hung on launch and "first
 * sync" appeared to take forever. The backlog is drained in the background by
 * the sync drain instead, which is single-flighted and chunked.
 *
 * Local only — no network — so the boot can bind the owner and start the tick
 * before anything online has answered.
 */
export async function initTimerOnBoot(): Promise<void> {
  const svc = getTimerService();
  // A fresh service has no owner yet, so binding the stored one counts as an
  // owner change and closes any dangling entry at the LAST PROOF OF LIFE — the
  // most recent liveness tick written while the timer was accruing. On a clean
  // restart this is ~seconds ago; after an ungraceful shutdown (battery death,
  // force-quit, panic) it's whenever the machine died — so the dead gap is
  // never credited.
  bindOwner(ownerFromTokens(await loadTokens()), true, 'boot');
  if (!svc.currentOwner()) return;
  const resent = svc.resyncTruncatedOnce();
  if (resent > 0) log.info('re-sending entries the server had cut short', { resent });
}

/**
 * Rebind after a sign-in. When the stored session belongs to someone else than
 * the bound owner (an account switch, or a sign-in after a session ended), the
 * previous owner's open entry is closed at its last proof of life BEFORE the
 * new owner is bound — never left open to be resumed over the gap later.
 */
export async function bindTimerToStoredSession(claimLegacy = false): Promise<boolean> {
  const owner = ownerFromTokens(await loadTokens());
  bindOwner(owner, claimLegacy, 'sign-in');
  return owner !== null;
}

function getTimerSyncDrain(): TimerSyncDrain {
  if (syncDrain) return syncDrain;
  syncDrain = new TimerSyncDrain({
    timer: getTimerService(),
    isOnline: () => net.isOnline(),
    logger: log,
  });
  return syncDrain;
}

export function startTimerSyncDrain(): void {
  timerRuntimeStarted = true;
  getTimerSyncDrain().start();
  getTodayLedgerHydrator().start();
}

export function applyTodayLedgerMode(mode: TodayLedgerMode): void {
  configuredTodayLedgerMode = mode;
  if (!service || !service.setTodayLedgerMode(mode)) return;
  broadcast('timer:status:push', service.status());
  if (timerRuntimeStarted && mode !== 'OFF') void refreshTodayLedger('config');
}

export function refreshTodayLedger(reason: TodayLedgerRefreshReason): Promise<void> {
  return getTodayLedgerHydrator().refresh(reason).catch((err) => {
    log.warn('today ledger refresh failed; keeping previous cache', { reason, err: String(err) });
  });
}

export function drainTimerSyncNow(reason: TimerSyncDrainReason): Promise<void> {
  return getTimerSyncDrain().drainNow(reason);
}

export { TimerService } from './timerService';
export type { TimerStatus } from '../../../shared/tracking';
export type { MissedSleep, TimerRecoveryNotice } from './types';
