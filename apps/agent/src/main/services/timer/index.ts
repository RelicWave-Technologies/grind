import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { app, net } from 'electron';
import path from 'node:path';
import { TimerService } from './timerService';
import { SqliteEntryStore } from './sqliteStore';
import { SqliteTodayLedgerStore } from './todayLedgerStore';
import { HttpSyncClient } from './syncClient';
import { TimerSyncDrain, type TimerSyncDrainReason } from './syncDrain';
import type { Clock, IdGen } from './types';
import { log } from '../../logger';
import { getTrackingReadinessService } from '../trackingReadiness';
import { getWorkspaceTimeContext } from '../workspaceTime';
import { loadTokens } from '../tokenStore';
import type { TimerOwner } from './types';
import { TodayLedgerHydrator, type TodayLedgerRefreshReason } from './todayLedgerHydrator';
import { api } from '../apiClient';
import { broadcast } from '../../broadcast';
import { getTodayLedgerMode } from '../agentConfig';
import type { TodayLedgerMode } from '@grind/types';

const realClock: Clock = { now: () => Date.now() };
const realIds: IdGen = { ulid: () => ulid() };

let service: TimerService | null = null;
let syncDrain: TimerSyncDrain | null = null;
let todayLedgerStore: SqliteTodayLedgerStore | null = null;
let todayLedgerHydrator: TodayLedgerHydrator | null = null;
let configuredTodayLedgerMode: TodayLedgerMode | null = null;
let timerRuntimeStarted = false;

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

/** Recover any left-open entry on boot, then flush the sync backlog. */
export async function initTimerOnBoot(): Promise<void> {
  const svc = getTimerService();
  const tokens = await loadTokens();
  if (!tokens) {
    svc.bindOwner(null);
    return;
  }
  const owner: TimerOwner = { userId: tokens.userId, workspaceId: tokens.workspaceId };
  svc.bindOwner(owner, true);
  // Close any dangling entry at the LAST PROOF OF LIFE — the most recent
  // liveness tick written while the timer was accruing. On a clean restart
  // this is ~seconds ago; after an ungraceful shutdown (battery death,
  // force-quit, panic) it's whenever the machine died — so the dead gap is
  // never credited. Falls back to now() only if liveness was never written
  // (very first run), which matches the prior conservative behavior.
  const lastAlive = svc.lastLiveness();
  const recovered = svc.recoverAway() ?? svc.recover(lastAlive ?? Date.now());
  if (recovered) {
    log.warn('timer recovered stale open entry', {
      entryId: recovered.entryId,
      recoveredAt: recovered.recoveredAt,
      reason: recovered.notice.reason,
    });
  }
  await svc.flushUnsynced();
}

export async function bindTimerToStoredSession(claimLegacy = false): Promise<boolean> {
  const tokens = await loadTokens();
  if (!tokens) {
    getTimerService().bindOwner(null);
    return false;
  }
  getTimerService().bindOwner({ userId: tokens.userId, workspaceId: tokens.workspaceId }, claimLegacy);
  return true;
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

export function stopTimerSyncDrain(): void {
  timerRuntimeStarted = false;
  syncDrain?.stop();
  todayLedgerHydrator?.stop();
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
export type { TimerRecoveryNotice } from './types';
