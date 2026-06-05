import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { app } from 'electron';
import path from 'node:path';
import { TimerService } from './timerService';
import { SqliteEntryStore } from './sqliteStore';
import { HttpSyncClient } from './syncClient';
import type { Clock, IdGen } from './types';
import { log } from '../../logger';

const realClock: Clock = { now: () => Date.now() };
const realIds: IdGen = { ulid: () => ulid() };

let service: TimerService | null = null;

/** Lazily build the timer service against the on-disk SQLite DB. */
export function getTimerService(): TimerService {
  if (service) return service;
  const dbPath = path.join(app.getPath('userData'), 'agent.db');
  const db = new Database(dbPath);
  const store = new SqliteEntryStore(db);
  service = new TimerService(store, new HttpSyncClient(), realClock, realIds);
  log.info('timer service initialized', { dbPath });
  return service;
}

/** Recover any left-open entry on boot, then flush the sync backlog. */
export async function initTimerOnBoot(): Promise<void> {
  const svc = getTimerService();
  // Close any dangling entry at the LAST PROOF OF LIFE — the most recent
  // liveness tick written while the timer was accruing. On a clean restart
  // this is ~seconds ago; after an ungraceful shutdown (battery death,
  // force-quit, panic) it's whenever the machine died — so the dead gap is
  // never credited. Falls back to now() only if liveness was never written
  // (very first run), which matches the prior conservative behavior.
  const lastAlive = svc.lastLiveness();
  svc.recover(lastAlive ?? Date.now());
  await svc.flushUnsynced();
}

export { TimerService } from './timerService';
export type { TimerStatus } from './timerService';
