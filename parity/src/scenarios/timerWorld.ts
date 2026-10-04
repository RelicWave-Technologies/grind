import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RowDump, Setup } from './timerTypes';

/** The simulated machine: a monotonic source that may tick on every read, and a device wall clock. */
export class World {
  mono: number;
  trueNow: number;
  skew: number;
  perCall: number;

  constructor(setup: Setup) {
    this.mono = setup.mono0;
    this.trueNow = setup.true0;
    this.skew = setup.skew;
    this.perCall = setup.perCall;
  }

  /** `performance.now()`: returns the current reading, then advances by `perCall`. */
  readMono(): number {
    const value = this.mono;
    this.mono += this.perCall;
    return value;
  }

  /** `Date.now()`. */
  deviceNow(): number {
    return this.trueNow + this.skew;
  }

  advance(ms: number): void {
    this.mono += ms;
    this.trueNow += ms;
  }

  /** The machine slept: real time passed, the monotonic source did not move. */
  suspend(ms: number): void {
    this.trueNow += ms;
  }
}

export class TrackingBlocked extends Error {
  readonly code = 'TRACKING_PERMISSIONS_REQUIRED';
  constructor() {
    super('Tracking permissions are required');
    this.name = 'TrackingBlockedError';
  }
}

/** A guard that allows, denies, or holds the call until released (a controllable yield point). */
export class ScriptedGuard {
  mode: 'allow' | 'deny' | 'hold' = 'allow';
  readonly held: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  async assertCanAccrue(): Promise<void> {
    if (this.mode === 'deny') throw new TrackingBlocked();
    if (this.mode === 'hold') {
      await new Promise<void>((resolve, reject) => this.held.push({ resolve, reject }));
    }
  }

  release(deny: boolean): boolean {
    const next = this.held.shift();
    if (!next) return false;
    if (deny) next.reject(new TrackingBlocked());
    else next.resolve();
    return true;
  }
}

/** Counter ids that look like ULIDs enough to sort like them. */
export class CounterIds {
  constructor(public n: number) {}
  ulid(): string {
    this.n += 1;
    return `ID${String(this.n).padStart(8, '0')}`;
  }
}

export const sha256hex = (text: string): string => createHash('sha256').update(text).digest('hex');

export function dumpEntries(db: Database.Database): RowDump[] {
  return db
    .prepare(
      `SELECT rowid, id, client_uuid, ended_at, typeof(ended_at) AS ended_at_type, synced, sync_state,
              owner_user_id, owner_workspace_id, acknowledged_revision,
              typeof(acknowledged_revision) AS acknowledged_revision_type, acknowledged_hash, json
       FROM local_entries ORDER BY rowid`,
    )
    .all() as RowDump[];
}

export function dumpMeta(db: Database.Database): Array<{ key: string; value: string }> {
  return db.prepare('SELECT key, value FROM timer_meta ORDER BY key').all() as Array<{ key: string; value: string }>;
}

/** The cache tables, or the error a broken table raises (a scenario may sabotage them). */
export function dumpCache(db: Database.Database): { entries: unknown[]; meta: unknown[] } | { error: string } {
  try {
    return dumpCacheTables(db);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function dumpCacheTables(db: Database.Database): { entries: unknown[]; meta: unknown[] } {
  return {
    entries: db
      .prepare(
        `SELECT owner_user_id, owner_workspace_id, day_start, typeof(day_start) AS day_start_type, day_end, entry_id,
                client_uuid, revision, typeof(revision) AS revision_type, fetched_at, typeof(fetched_at) AS fetched_at_type,
                canonical_json, effective_json
         FROM server_entry_cache ORDER BY owner_user_id, owner_workspace_id, day_start, entry_id`,
      )
      .all(),
    meta: db
      .prepare(
        `SELECT owner_user_id, owner_workspace_id, day_start, day_end, server_time, typeof(server_time) AS server_time_type,
                workspace_timezone, fetched_at, typeof(fetched_at) AS fetched_at_type
         FROM server_snapshot_meta ORDER BY owner_user_id, owner_workspace_id, day_start`,
      )
      .all(),
  };
}
