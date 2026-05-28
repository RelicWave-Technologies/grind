import type Database from 'better-sqlite3';
import type { TimeEntry } from '@grind/core';
import type { EntryStore } from './types';

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
        json        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_entries_open ON local_entries(ended_at);
      CREATE INDEX IF NOT EXISTS idx_local_entries_synced ON local_entries(synced);
    `);
  }

  upsert(entry: TimeEntry): void {
    this.db
      .prepare(
        `INSERT INTO local_entries (id, client_uuid, ended_at, synced, json)
         VALUES (@id, @clientUuid, @endedAt, 0, @json)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           synced   = 0,
           json     = excluded.json`,
      )
      .run({
        id: entry.id,
        clientUuid: entry.clientUuid,
        endedAt: entry.endedAt,
        json: JSON.stringify(entry),
      });
  }

  getOpen(): TimeEntry | null {
    const row = this.db
      .prepare(`SELECT json FROM local_entries WHERE ended_at IS NULL ORDER BY rowid DESC LIMIT 1`)
      .get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as TimeEntry) : null;
  }

  getUnsynced(): TimeEntry[] {
    const rows = this.db
      .prepare(`SELECT json FROM local_entries WHERE synced = 0 ORDER BY rowid ASC`)
      .all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as TimeEntry);
  }

  listRecent(limit: number): TimeEntry[] {
    const rows = this.db
      .prepare(`SELECT json FROM local_entries ORDER BY rowid DESC LIMIT ?`)
      .all(limit) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as TimeEntry);
  }

  markSynced(entryId: string): void {
    this.db.prepare(`UPDATE local_entries SET synced = 1 WHERE id = ?`).run(entryId);
  }
}
