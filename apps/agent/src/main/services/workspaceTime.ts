import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  TimeZoneSchema,
  dateKeyInTimeZone,
  localDayWindowInTimeZone,
} from '@grind/types';
import type { WorkspaceTimeContext } from '../../shared/workspaceTime';
import { log } from '../logger';
import { loadTokens } from './tokenStore';
import { serverAlignedNow } from './serverClock';

interface PersistedWorkspaceTime {
  workspaceId: string;
  timeZone: string;
}

let timeZone: string | null = null;
let source: WorkspaceTimeContext['source'] = 'unavailable';
let workspaceId: string | null = null;
let initialized = false;
let initialization: Promise<void> | null = null;
let sessionGeneration = 0;
let writeChain = Promise.resolve();
const listeners = new Set<(context: WorkspaceTimeContext) => void>();
/**
 * The business day of the session that just ended. A timer can outlive its
 * session (the server ended it; tracked time keeps accruing and uploads after
 * sign-in), and its widget still needs a day to total — see getTimerDayContext.
 */
let endedSession: { workspaceId: string; timeZone: string } | null = null;
/** The date listeners last heard about; a change of date is news too. */
let notifiedDate: string | null = null;
let rolloverWatch: NodeJS.Timeout | null = null;

/**
 * How often to check whether the business day has turned over. Polled rather
 * than one timeout aimed at midnight: timers run on a monotonic clock that
 * stops while a Mac sleeps, so a timeout set before a sleep fires late by the
 * whole sleep. A poll looks at the clock itself.
 */
const DAY_ROLLOVER_CHECK_MS = 30_000;

function cachePath(): string {
  return path.join(app.getPath('userData'), 'workspace-time.json');
}

function parsePersisted(raw: unknown): PersistedWorkspaceTime | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { workspaceId?: unknown; timeZone?: unknown };
  const parsed = TimeZoneSchema.safeParse(candidate.timeZone);
  if (!parsed.success || typeof candidate.workspaceId !== 'string' || candidate.workspaceId.length === 0) {
    return null;
  }
  return { workspaceId: candidate.workspaceId, timeZone: parsed.data };
}

function unavailableContext(): WorkspaceTimeContext {
  return { ready: false, timeZone: null, source: 'unavailable', date: null, dayStart: null, dayEnd: null };
}

function notifyListeners(now = serverAlignedNow()): void {
  const context = contextAt(now);
  notifiedDate = context.date;
  for (const listener of listeners) {
    try {
      listener(context);
    } catch (err) {
      log.warn('workspace time listener failed', { err: String(err) });
    }
  }
}

/** Restore the offline clock only when it belongs to the encrypted session
 * currently stored on this machine. A shared laptop must never inherit the
 * previous workspace's business day. */
export async function initializeWorkspaceTime(): Promise<void> {
  if (initialized) return;
  if (initialization) return initialization;

  const generation = sessionGeneration;
  initialization = (async () => {
    let tokens: Awaited<ReturnType<typeof loadTokens>>;
    try {
      tokens = await loadTokens();
    } catch (err) {
      log.warn('workspace session unavailable; waiting for server config', { err: String(err) });
      return;
    }
    if (!tokens) return;

    let persisted: PersistedWorkspaceTime | null = null;
    try {
      persisted = parsePersisted(JSON.parse(await fs.readFile(cachePath(), 'utf8')));
      if (!persisted) throw new Error('invalid_workspace_time_cache');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('workspace time cache unreadable; waiting for server config', { err: String(err) });
      }
    }

    if (generation !== sessionGeneration) return;
    workspaceId = tokens.workspaceId;
    if (persisted?.workspaceId === tokens.workspaceId) {
      timeZone = persisted.timeZone;
      source = 'cache';
    }
  })().finally(() => {
    if (generation === sessionGeneration) initialized = true;
    initialization = null;
  });
  return initialization;
}

function contextAt(
  now: number,
  zone: string | null = timeZone,
  zoneSource: WorkspaceTimeContext['source'] = source,
): WorkspaceTimeContext {
  if (!zone) return unavailableContext();
  const date = dateKeyInTimeZone(now, zone);
  const window = localDayWindowInTimeZone(date, zone);
  if (!window) return unavailableContext();
  return {
    ready: true,
    timeZone: zone,
    source: zoneSource,
    date,
    dayStart: window.start.getTime(),
    dayEnd: window.end.getTime(),
  };
}

/**
 * The business day the timer totals against. Same as the session's, except
 * after a session ENDS: an entry of that workspace may still be running, and
 * without a day the tray and floating bar read 00:00 while it accrues. It
 * keeps the ended session's day — but only for a timer of that workspace, so
 * a shared machine never shows one workspace's time on another's calendar.
 */
export function getTimerDayContext(now: number, timerWorkspaceId: string | null): WorkspaceTimeContext {
  const context = contextAt(now);
  if (context.ready || !endedSession || endedSession.workspaceId !== timerWorkspaceId) return context;
  return contextAt(now, endedSession.timeZone, 'cache');
}

/** Fire the listeners when the business day turns over, not only when the zone changes. */
export function checkDayRollover(now = serverAlignedNow()): void {
  const { date } = contextAt(now);
  if (date === null) return;
  if (notifiedDate === null) {
    notifiedDate = date;
    return;
  }
  if (date !== notifiedDate) notifyListeners(now);
}

/**
 * Which business day it is. Defaults to the server-aligned clock: four callers
 * took this default while the timer passed its own clock explicitly, so near
 * midnight a skewed machine could file a segment under one day and its
 * screenshots under another.
 */
export function getWorkspaceTimeContext(now = serverAlignedNow()): WorkspaceTimeContext {
  return contextAt(now);
}

export function getWorkspaceTimeZone(): string | null {
  return timeZone;
}

export function onWorkspaceTimeChange(listener: (context: WorkspaceTimeContext) => void): () => void {
  listeners.add(listener);
  if (!rolloverWatch) {
    rolloverWatch = setInterval(() => checkDayRollover(), DAY_ROLLOVER_CHECK_MS);
    rolloverWatch.unref?.();
  }
  return () => listeners.delete(listener);
}

export async function applyServerWorkspaceTimeZone(value: string, expectedWorkspaceId: string): Promise<void> {
  await initializeWorkspaceTime();
  const parsed = TimeZoneSchema.parse(value);
  const tokens = await loadTokens();
  if (!tokens || tokens.workspaceId !== expectedWorkspaceId) {
    throw new Error('workspace_session_changed');
  }

  const changed = parsed !== timeZone || source !== 'server' || workspaceId !== expectedWorkspaceId;
  workspaceId = expectedWorkspaceId;
  timeZone = parsed;
  source = 'server';

  const target = cachePath();
  const tmp = `${target}.${process.pid}.tmp`;
  writeChain = writeChain.then(async () => {
    try {
      await fs.writeFile(
        tmp,
        JSON.stringify({ workspaceId: expectedWorkspaceId, timeZone: parsed } satisfies PersistedWorkspaceTime),
        { mode: 0o600 },
      );
      await fs.rename(tmp, target);
    } catch (err) {
      void fs.unlink(tmp).catch(() => undefined);
      log.warn('workspace time cache write failed', { err: String(err) });
    }
  });
  await writeChain;

  const currentTokens = await loadTokens();
  if (!currentTokens || currentTokens.workspaceId !== expectedWorkspaceId) {
    if (workspaceId === expectedWorkspaceId) clearWorkspaceTimeSession();
    throw new Error('workspace_session_changed');
  }

  if (changed) notifyListeners();
}

/** Drop in-memory business-day state at an auth boundary. The scoped cache is
 * retained so the same workspace can recover offline on the next boot. */
export function clearWorkspaceTimeSession(): void {
  const changed = timeZone !== null || workspaceId !== null || source !== 'unavailable';
  if (workspaceId !== null && timeZone !== null) endedSession = { workspaceId, timeZone };
  sessionGeneration += 1;
  initialized = true;
  workspaceId = null;
  timeZone = null;
  source = 'unavailable';
  if (changed) notifyListeners();
}
