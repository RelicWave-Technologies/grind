import type Database from 'better-sqlite3';
import type { TimeEntry } from '@grind/core';
import type {
  EntryStore,
  EntrySyncState,
  LocalLedgerEntry,
  PendingEntrySyncState,
  TimerOwner,
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
    pauseReason: raw.pauseReason === 'IDLE' || raw.pauseReason === 'MANUAL' || raw.pauseReason === 'PERMISSION_REQUIRED'
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
    && raw.reason !== 'server_clock_corrected'
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
 * unsynced entries). WAL mode + synchronous=FULL makes acknowledged local
 * mutations survive process and OS crashes before they are published to UI.
 */
export class SqliteEntryStore implements EntryStore {
  private owner: TimerOwner | null = null;

  constructor(private readonly db: Database.Database) {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_entries (
        id          TEXT PRIMARY KEY,
        client_uuid TEXT NOT NULL UNIQUE,
        ended_at    INTEGER,
        synced      INTEGER NOT NULL DEFAULT 0,
        sync_state  TEXT NOT NULL DEFAULT 'pending_create'
          CHECK (sync_state IN ('pending_create', 'pending_update', 'synced')),
        owner_user_id TEXT,
        owner_workspace_id TEXT,
        acknowledged_revision INTEGER,
        acknowledged_hash TEXT,
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
    this.migrateOwnership();
  }

  bindOwner(owner: TimerOwner | null): void {
    this.owner = owner ? { ...owner } : null;
  }

  currentOwner(): TimerOwner | null {
    return this.owner ? { ...this.owner } : null;
  }

  claimUnownedEntries(owner: TimerOwner): number {
    const claim = this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT id, ended_at, json FROM local_entries
         WHERE owner_user_id IS NULL AND owner_workspace_id IS NULL`,
      ).all() as Array<{ id: string; ended_at: number | null; json: string }>;
      const update = this.db.prepare(
        `UPDATE local_entries
         SET owner_user_id = @userId, owner_workspace_id = @workspaceId, json = @json
         WHERE id = @id AND owner_user_id IS NULL AND owner_workspace_id IS NULL`,
      );
      let claimed = 0;
      let claimedOpen = false;
      for (const row of rows) {
        const entry = parseEntry(row.json);
        // Older agents wrote the placeholder userId "self". That does not
        // prove ownership after an account switch, so keep it quarantined
        // until an owner-scoped server snapshot proves id + clientUuid.
        if (entry.userId !== owner.userId) continue;
        const changes = update.run({
          id: row.id,
          userId: owner.userId,
          workspaceId: owner.workspaceId,
          json: JSON.stringify(entry),
        }).changes;
        claimed += changes;
        if (changes > 0 && row.ended_at === null) claimedOpen = true;
      }
      if (claimedOpen) {
        for (const key of ['liveness', 'exit_intent', 'away_state', 'recovery_notice']) {
          this.db.prepare(
            `INSERT OR IGNORE INTO timer_meta (key, value)
             SELECT @nextKey, value FROM timer_meta WHERE key = @legacyKey`,
          ).run({ nextKey: this.ownerMetaKey(owner, key), legacyKey: key });
        }
      }
      return claimed;
    });
    return claim();
  }

  claimServerMatchedEntries(owner: TimerOwner, matches: Array<{ id: string; clientUuid: string }>): number {
    if (matches.length === 0) return 0;
    const claim = this.db.transaction(() => {
      const find = this.db.prepare(
        `SELECT json FROM local_entries
         WHERE id = ? AND client_uuid = ?
           AND ended_at IS NOT NULL
           AND owner_user_id IS NULL AND owner_workspace_id IS NULL`,
      );
      const update = this.db.prepare(
        `UPDATE local_entries
         SET owner_user_id = @userId, owner_workspace_id = @workspaceId, json = @json
         WHERE id = @id AND client_uuid = @clientUuid
           AND ended_at IS NOT NULL
           AND owner_user_id IS NULL AND owner_workspace_id IS NULL`,
      );
      let claimed = 0;
      for (const match of matches) {
        const row = find.get(match.id, match.clientUuid) as { json: string } | undefined;
        if (!row) continue;
        const entry = parseEntry(row.json);
        claimed += update.run({
          id: match.id,
          clientUuid: match.clientUuid,
          userId: owner.userId,
          workspaceId: owner.workspaceId,
          json: JSON.stringify({ ...entry, userId: owner.userId }),
        }).changes;
      }
      return claimed;
    });
    return claim();
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

  private migrateOwnership(): void {
    const columns = this.db.prepare(`PRAGMA table_info(local_entries)`).all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('owner_user_id')) this.db.exec(`ALTER TABLE local_entries ADD COLUMN owner_user_id TEXT`);
    if (!names.has('owner_workspace_id')) this.db.exec(`ALTER TABLE local_entries ADD COLUMN owner_workspace_id TEXT`);
    if (!names.has('acknowledged_revision')) this.db.exec(`ALTER TABLE local_entries ADD COLUMN acknowledged_revision INTEGER`);
    if (!names.has('acknowledged_hash')) this.db.exec(`ALTER TABLE local_entries ADD COLUMN acknowledged_hash TEXT`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_local_entries_owner_open
        ON local_entries(owner_user_id, owner_workspace_id, ended_at);
      CREATE INDEX IF NOT EXISTS idx_local_entries_owner_sync
        ON local_entries(owner_user_id, owner_workspace_id, sync_state);
    `);
  }

  setLiveness(ts: number): void {
    const owner = this.requireOwner();
    this.db.prepare(
      `INSERT INTO timer_meta (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run({ key: this.ownerMetaKey(owner, 'liveness'), value: String(ts) });
  }

  getLiveness(): number | null {
    const owner = this.owner;
    if (!owner) return null;
    const row = this.db.prepare(`SELECT value FROM timer_meta WHERE key = ?`)
      .get(this.ownerMetaKey(owner, 'liveness')) as { value: string } | undefined;
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
    const owner = this.requireOwner();
    if (entry.userId !== owner.userId) throw new Error('timer_owner_mismatch');
    const existingOwner = this.db.prepare(
      `SELECT owner_user_id, owner_workspace_id FROM local_entries WHERE id = ?`,
    ).get(entry.id) as { owner_user_id: string | null; owner_workspace_id: string | null } | undefined;
    if (
      existingOwner
      && (existingOwner.owner_user_id !== owner.userId || existingOwner.owner_workspace_id !== owner.workspaceId)
    ) {
      throw new Error('timer_entry_owned_by_another_session');
    }
    const existing = this.getSyncState(entry.id);
    const nextState = opts?.syncState ?? (existing === 'pending_create' ? 'pending_create' : existing ? 'pending_update' : 'pending_create');
    this.db
      .prepare(
        `INSERT INTO local_entries (
           id, client_uuid, ended_at, synced, sync_state,
           owner_user_id, owner_workspace_id, acknowledged_revision, acknowledged_hash, json
         )
         VALUES (
           @id, @clientUuid, @endedAt, @synced, @syncState,
           @ownerUserId, @ownerWorkspaceId, NULL, NULL, @json
         )
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           synced   = excluded.synced,
           sync_state = excluded.sync_state,
           acknowledged_revision = CASE WHEN excluded.json = local_entries.json
             THEN local_entries.acknowledged_revision ELSE NULL END,
           acknowledged_hash = CASE WHEN excluded.json = local_entries.json
             THEN local_entries.acknowledged_hash ELSE NULL END,
           json     = excluded.json`,
      )
      .run({
        id: entry.id,
        clientUuid: entry.clientUuid,
        endedAt: entry.endedAt,
        synced: syncedFlag(nextState),
        syncState: nextState,
        ownerUserId: owner.userId,
        ownerWorkspaceId: owner.workspaceId,
        json: JSON.stringify(entry),
      });
    return nextState;
  }

  switchEntry(closed: TimeEntry, next: TimeEntry): [PendingEntrySyncState, PendingEntrySyncState] {
    const persist = this.db.transaction(() => [
      this.upsert(closed),
      this.upsert(next, { syncState: 'pending_create' }),
    ] as [PendingEntrySyncState, PendingEntrySyncState]);
    return persist();
  }

  getOpen(): TimeEntry | null {
    const owner = this.owner;
    if (!owner) return null;
    const row = this.db.prepare(
      `SELECT json FROM local_entries
       WHERE owner_user_id = ? AND owner_workspace_id = ? AND ended_at IS NULL
       ORDER BY rowid DESC LIMIT 1`,
    ).get(owner.userId, owner.workspaceId) as { json: string } | undefined;
    return row ? parseEntry(row.json) : null;
  }

  getUnsynced(): UnsyncedEntry[] {
    const owner = this.owner;
    if (!owner) return [];
    const rows = this.db
      .prepare(
        `SELECT json, sync_state
         FROM local_entries
         WHERE owner_user_id = ? AND owner_workspace_id = ?
           AND sync_state IN ('pending_create', 'pending_update')
         ORDER BY rowid ASC`,
      )
      .all(owner.userId, owner.workspaceId) as { json: string; sync_state: string }[];
    return rows.map((r) => ({
      entry: parseEntry(r.json),
      syncState: asSyncState(r.sync_state) as PendingEntrySyncState,
    }));
  }

  hasUnsynced(): boolean {
    const owner = this.owner;
    if (!owner) return false;
    const row = this.db.prepare(
      `SELECT 1 AS found FROM local_entries
       WHERE owner_user_id = ? AND owner_workspace_id = ?
         AND sync_state IN ('pending_create', 'pending_update') LIMIT 1`,
    ).get(owner.userId, owner.workspaceId) as { found: number } | undefined;
    return Boolean(row);
  }

  isPendingCreate(entryId: string): boolean {
    return this.getSyncState(entryId) === 'pending_create';
  }

  listRecent(limit: number): TimeEntry[] {
    const owner = this.owner;
    if (!owner) return [];
    const rows = this.db.prepare(
      `SELECT json FROM local_entries
       WHERE owner_user_id = ? AND owner_workspace_id = ?
       ORDER BY rowid DESC LIMIT ?`,
    ).all(owner.userId, owner.workspaceId, limit) as { json: string }[];
    return rows.map((r) => parseEntry(r.json));
  }

  listSince(since: number): TimeEntry[] {
    const owner = this.owner;
    if (!owner) return [];
    const rows = this.db
      .prepare(
        `SELECT json FROM local_entries
         WHERE owner_user_id = ? AND owner_workspace_id = ?
           AND (ended_at IS NULL OR ended_at >= ?)
         ORDER BY rowid DESC`,
      )
      .all(owner.userId, owner.workspaceId, since) as { json: string }[];
    return rows.map((r) => parseEntry(r.json));
  }

  listLedgerEntries(since: number): LocalLedgerEntry[] {
    const owner = this.owner;
    if (!owner) return [];
    const rows = this.db.prepare(
      `SELECT json, sync_state, acknowledged_revision, acknowledged_hash
       FROM local_entries
       WHERE owner_user_id = ? AND owner_workspace_id = ?
         AND (ended_at IS NULL OR ended_at >= ?)
       ORDER BY rowid DESC`,
    ).all(owner.userId, owner.workspaceId, since) as Array<{
      json: string;
      sync_state: string;
      acknowledged_revision: number | null;
      acknowledged_hash: string | null;
    }>;
    return rows.map((row) => ({
      entry: parseEntry(row.json),
      syncState: asSyncState(row.sync_state),
      acknowledgedRevision: row.acknowledged_revision,
      acknowledgedHash: row.acknowledged_hash,
    }));
  }

  markCreated(entryId: string, expectedEntry: TimeEntry): boolean {
    const owner = this.requireOwner();
    const info = this.db.prepare(
      `UPDATE local_entries SET synced = 0, sync_state = 'pending_update'
       WHERE id = ? AND owner_user_id = ? AND owner_workspace_id = ?
         AND json = ? AND sync_state = 'pending_create'`,
    ).run(entryId, owner.userId, owner.workspaceId, JSON.stringify(expectedEntry));
    return info.changes > 0;
  }

  markPendingCreate(entryId: string, expectedEntry: TimeEntry): boolean {
    const owner = this.requireOwner();
    const info = this.db.prepare(
      `UPDATE local_entries SET synced = 0, sync_state = 'pending_create'
       WHERE id = ? AND owner_user_id = ? AND owner_workspace_id = ?
         AND json = ?`,
    ).run(entryId, owner.userId, owner.workspaceId, JSON.stringify(expectedEntry));
    return info.changes > 0;
  }

  markSynced(
    entryId: string,
    expectedEntry: TimeEntry,
    acknowledgement: { revision: number; hash: string },
  ): boolean {
    const owner = this.requireOwner();
    const info = this.db.prepare(
      `UPDATE local_entries
       SET synced = 1, sync_state = 'synced',
           acknowledged_revision = @revision, acknowledged_hash = @hash
       WHERE id = @id AND owner_user_id = @ownerUserId AND owner_workspace_id = @ownerWorkspaceId
         AND json = @json`,
    ).run({
      id: entryId,
      ownerUserId: owner.userId,
      ownerWorkspaceId: owner.workspaceId,
      json: JSON.stringify(expectedEntry),
      revision: acknowledgement.revision,
      hash: acknowledgement.hash,
    });
    return info.changes > 0;
  }

  private getSyncState(entryId: string): EntrySyncState | null {
    const owner = this.owner;
    if (!owner) return null;
    const row = this.db.prepare(
      `SELECT sync_state FROM local_entries
       WHERE id = ? AND owner_user_id = ? AND owner_workspace_id = ?`,
    ).get(entryId, owner.userId, owner.workspaceId) as { sync_state: string } | undefined;
    return row ? asSyncState(row.sync_state) : null;
  }

  private setJsonMeta(key: string, value: unknown): void {
    const owner = this.requireOwner();
    this.db
      .prepare(
        `INSERT INTO timer_meta (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ key: this.ownerMetaKey(owner, key), value: JSON.stringify(value) });
  }

  private getJsonMeta(key: string): unknown | null {
    const owner = this.owner;
    if (!owner) return null;
    const row = this.db.prepare(`SELECT value FROM timer_meta WHERE key = ?`)
      .get(this.ownerMetaKey(owner, key)) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
  }

  private deleteMeta(key: string): void {
    const owner = this.owner;
    if (!owner) return;
    this.db.prepare(`DELETE FROM timer_meta WHERE key = ?`).run(this.ownerMetaKey(owner, key));
  }

  private requireOwner(): TimerOwner {
    if (!this.owner) throw new Error('timer_owner_unavailable');
    return this.owner;
  }

  private ownerMetaKey(owner: TimerOwner, key: string): string {
    return `${owner.workspaceId}:${owner.userId}:${key}`;
  }
}
