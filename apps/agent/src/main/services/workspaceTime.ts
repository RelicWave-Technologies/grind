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

function notifyListeners(): void {
  const context = contextAt(Date.now());
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

function contextAt(now: number): WorkspaceTimeContext {
  if (!timeZone) return unavailableContext();
  const date = dateKeyInTimeZone(now, timeZone);
  const window = localDayWindowInTimeZone(date, timeZone);
  if (!window) return unavailableContext();
  return {
    ready: true,
    timeZone,
    source,
    date,
    dayStart: window.start.getTime(),
    dayEnd: window.end.getTime(),
  };
}

export function getWorkspaceTimeContext(now = Date.now()): WorkspaceTimeContext {
  return contextAt(now);
}

export function getWorkspaceTimeZone(): string | null {
  return timeZone;
}

export function onWorkspaceTimeChange(listener: (context: WorkspaceTimeContext) => void): () => void {
  listeners.add(listener);
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
  sessionGeneration += 1;
  initialized = true;
  workspaceId = null;
  timeZone = null;
  source = 'unavailable';
  if (changed) notifyListeners();
}
