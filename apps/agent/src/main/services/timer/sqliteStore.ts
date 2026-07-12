import type Database from 'better-sqlite3';
import type { TimeEntry } from '@grind/core';
import type {
  EntryStore,
  EntrySyncState,
  PendingEntrySyncState,
  TimerAwayState,
  TimerExitIntent,
  TimerRecoveryNotice,
  UnsyncedEntry,
} from './types';

function syncedFlag(syncState: EntrySyncState): 0 | 1 {
  return syncState === 'synced' ? 1 : 0;
}

function asSyncState(value: unknown): EntrySyncState {
  if (value === 'pending_create' || value === 'pending_update' || value === 'synced') return value;
  return 'pending_create';
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseEntry(json: string): TimeEntry {
  const raw = JSON.parse(json) as TimeEntry & { revision?: unknown; closeReason?: unknown; pauseReason?: unknown };
  return {
    ...raw,
    revision: typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision >= 0
      ? raw.revision
      : 0,
    closeReason: raw.closeReason === 'AGENT_RECOVERY' || raw.closeReason === 'AGENT'
      ? raw.closeReason
      : null,
    pauseReason: raw.pauseReason === 'IDLE' || raw.pauseReason === 'PERMISSION_REQUIRED'
      ? raw.pauseReason
      : null,
  };
}

function asExitIntent(value: unknown): TimerExitIntent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<TimerExitIntent>;
  if (raw.reason !== 'quit' && raw.reason !== 'update' && raw.reason !== 'shutdown') return null;
  if (typeof raw.entryId !== 'string' || raw.entryId.length === 0) return null;
  const observedAt = asFiniteNumber(raw.observedAt);
  return observedAt === null ? null : { reason: raw.reason, entryId: raw.entryId, observedAt };
}

function asRecoveryNotice(value: unknown): TimerRecoveryNotice | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<TimerRecoveryNotice>;
  if (
    raw.reason !== 'unexpected_shutdown'
    && raw.reason !== 'sleep_stop'
    && raw.reason !== 'lock_stop'
    && raw.reason !== 'server_finalized'
  ) return null;
  if (typeof raw.entryId !== 'string' || raw.entryId.length === 0) return null;
  const recoveredAt = asFiniteNumber(raw.recoveredAt);
  const observedAt = asFiniteNumber(raw.observedAt);
  return recoveredAt === null || observedAt === null ? null : { reason: raw.reason, entryId: raw.entryId, recoveredAt, observedAt };
}

function asAwayState(value: unknown): TimerAwayState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<TimerAwayState>;
  if (raw.reason !== 'suspend' && raw.reason !== 'lock') return null;
  if (typeof raw.entryId !== 'string' || raw.entryId.length === 0) return null;
  const awayStartedAt = asFiniteNumber(raw.awayStartedAt);
  const observedAt = asFiniteNumber(raw.observedAt);
  return awayStartedAt === null || observedAt === null ? null : { reason: raw.reason, entryId: raw.entryId, awayStartedAt, observedAt };
}

/**
 * better-sqlite3-backed EntryStore. Each entry is stored as a JSON blob with
 * indexed columns (ended_at, synced) for the two hot queries (open entry,
 * unsynced entries). WAL mode + synchronous=NORMAL = durable across crashes.
 */
export class SqliteEntryStore implements EntryStore {
  constructor(private readonly db: Database.Database) {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_entries (
        id          TEXT PRIMARY KEY,
        client_uuid TEXT NOT NULL UNIQUE,
        ended_at    INTEGER,
        synced      INTEGER NOT NULL DEFAULT 0,
        sync_state  TEXT NOT NULL DEFAULT 'pending_create'
          CHECK (sync_state IN ('pending_create', 'pending_update', 'synced')),
        json        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_entries_open ON local_entries(ended_at);
      CREATE INDEX IF NOT EXISTS idx_local_entries_synced ON local_entries(synced);
      CREATE TABLE IF NOT EXISTS timer_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.migrateSyncState();
  }

  private migrateSyncState(): void {
    const columns = this.db.prepare(`PRAGMA table_info(local_entries)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === 'sync_state')) {
      this.db.exec(`
        ALTER TABLE local_entries ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending_create';
        UPDATE local_entries
        SET sync_state = CASE WHEN synced = 1 THEN 'synced' ELSE 'pending_create' END;
      `);
    }
    this.db.exec(`
      UPDATE local_entries
      SET sync_state = CASE WHEN synced = 1 THEN 'synced' ELSE sync_state END
      WHERE sync_state NOT IN ('pending_create', 'pending_update', 'synced')
         OR (synced = 1 AND sync_state <> 'synced');
      CREATE INDEX IF NOT EXISTS idx_local_entries_sync_state ON local_entries(sync_state);
    `);
  }

  setLiveness(ts: number): void {
    this.db
      .prepare(
        `INSERT INTO timer_meta (key, value) VALUES ('liveness', @v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ v: String(ts) });
  }

  getLiveness(): number | null {
    const row = this.db
      .prepare(`SELECT value FROM timer_meta WHERE key = 'liveness'`)
      .get() as { value: string } | undefined;
    if (!row) return null;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : null;
  }

  setExitIntent(intent: TimerExitIntent): void {
    this.setJsonMeta('exit_intent', intent);
  }

  getExitIntent(): TimerExitIntent | null {
    return asExitIntent(this.getJsonMeta('exit_intent'));
  }

  clearExitIntent(): void {
    this.deleteMeta('exit_intent');
  }

  setAwayState(state: TimerAwayState): void {
    this.setJsonMeta('away_state', state);
  }

  getAwayState(): TimerAwayState | null {
    return asAwayState(this.getJsonMeta('away_state'));
  }

  clearAwayState(): void {
    this.deleteMeta('away_state');
  }

  setRecoveryNotice(notice: TimerRecoveryNotice): void {
    this.setJsonMeta('recovery_notice', notice);
  }

  getRecoveryNotice(): TimerRecoveryNotice | null {
    return asRecoveryNotice(this.getJsonMeta('recovery_notice'));
  }

  clearRecoveryNotice(): void {
    this.deleteMeta('recovery_notice');
  }

  upsert(entry: TimeEntry, opts?: { syncState?: PendingEntrySyncState }): PendingEntrySyncState {
    const existing = this.getSyncState(entry.id);
    const nextState = opts?.syncState ?? (existing === 'pending_create' ? 'pending_create' : existing ? 'pending_update' : 'pending_create');
    this.db
      .prepare(
        `INSERT INTO local_entries (id, client_uuid, ended_at, synced, sync_state, json)
         VALUES (@id, @clientUuid, @endedAt, @synced, @syncState, @json)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           synced   = excluded.synced,
           sync_state = excluded.sync_state,
           json     = excluded.json`,
      )
      .run({
        id: entry.id,
        clientUuid: entry.clientUuid,
        endedAt: entry.endedAt,
        synced: syncedFlag(nextState),
        syncState: nextState,
        json: JSON.stringify(entry),
      });
    return nextState;
  }

  getOpen(): TimeEntry | null {
    const row = this.db
      .prepare(`SELECT json FROM local_entries WHERE ended_at IS NULL ORDER BY rowid DESC LIMIT 1`)
      .get() as { json: string } | undefined;
    return row ? parseEntry(row.json) : null;
  }

  getUnsynced(): UnsyncedEntry[] {
    const rows = this.db
      .prepare(
        `SELECT json, sync_state
         FROM local_entries
         WHERE sync_state IN ('pending_create', 'pending_update')
         ORDER BY rowid ASC`,
      )
      .all() as { json: string; sync_state: string }[];
    return rows.map((r) => ({
      entry: parseEntry(r.json),
      syncState: asSyncState(r.sync_state) as PendingEntrySyncState,
    }));
  }

  isPendingCreate(entryId: string): boolean {
    return this.getSyncState(entryId) === 'pending_create';
  }

  listRecent(limit: number): TimeEntry[] {
    const rows = this.db
      .prepare(`SELECT json FROM local_entries ORDER BY rowid DESC LIMIT ?`)
      .all(limit) as { json: string }[];
    return rows.map((r) => parseEntry(r.json));
  }

  listSince(since: number): TimeEntry[] {
    const rows = this.db
      .prepare(
        `SELECT json FROM local_entries
         WHERE ended_at IS NULL OR ended_at >= ?
         ORDER BY rowid DESC`,
      )
      .all(since) as { json: string }[];
    return rows.map((r) => parseEntry(r.json));
  }

  markCreated(entryId: string): void {
    this.db.prepare(`UPDATE local_entries SET synced = 0, sync_state = 'pending_update' WHERE id = ?`).run(entryId);
  }

  markPendingCreate(entryId: string): void {
    this.db.prepare(`UPDATE local_entries SET synced = 0, sync_state = 'pending_create' WHERE id = ?`).run(entryId);
  }

  markSynced(entryId: string, expectedEntry?: TimeEntry): boolean {
    const info = expectedEntry
      ? this.db
          .prepare(`UPDATE local_entries SET synced = 1, sync_state = 'synced' WHERE id = ? AND json = ?`)
          .run(entryId, JSON.stringify(expectedEntry))
      : this.db.prepare(`UPDATE local_entries SET synced = 1, sync_state = 'synced' WHERE id = ?`).run(entryId);
    return info.changes > 0;
  }

  private getSyncState(entryId: string): EntrySyncState | null {
    const row = this.db
      .prepare(`SELECT sync_state FROM local_entries WHERE id = ?`)
      .get(entryId) as { sync_state: string } | undefined;
    return row ? asSyncState(row.sync_state) : null;
  }

  private setJsonMeta(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO timer_meta (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ key, value: JSON.stringify(value) });
  }

  private getJsonMeta(key: string): unknown | null {
    const row = this.db.prepare(`SELECT value FROM timer_meta WHERE key = ?`).get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
  }

  private deleteMeta(key: string): void {
    this.db.prepare(`DELETE FROM timer_meta WHERE key = ?`).run(key);
  }
}
