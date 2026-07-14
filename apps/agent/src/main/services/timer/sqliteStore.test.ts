import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createTimeEntry, closeTimeEntry, type TimeEntry } from '@grind/core';
import { SqliteEntryStore } from './sqliteStore';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function entry(id = 'entry_1'): TimeEntry {
  return createTimeEntry({
    id,
    clientUuid: `client_${id}`,
    userId: 'self',
    source: 'AUTO',
    startedAt: T0,
    segmentId: `segment_${id}`,
  });
}

function oldSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE local_entries (
      id          TEXT PRIMARY KEY,
      client_uuid TEXT NOT NULL UNIQUE,
      ended_at    INTEGER,
      synced      INTEGER NOT NULL DEFAULT 0,
      json        TEXT NOT NULL
    );
    CREATE TABLE timer_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function canOpenBetterSqlite(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const describeSqlite = canOpenBetterSqlite() ? describe : describe.skip;

describeSqlite('SqliteEntryStore sync state', () => {
  it('stores new rows as pending_create and marks synced rows clean', () => {
    const db = new Database(':memory:');
    const store = new SqliteEntryStore(db);
    const e = entry();

    expect(store.upsert(e)).toBe('pending_create');
    expect(store.isPendingCreate(e.id)).toBe(true);
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);

    store.markSynced(e.id);
    expect(store.isPendingCreate(e.id)).toBe(false);
    expect(store.getUnsynced()).toHaveLength(0);
  });

  it('does not mark synced when the local snapshot changed during sync', () => {
    const db = new Database(':memory:');
    const store = new SqliteEntryStore(db);
    const e = entry();
    store.upsert(e, { syncState: 'pending_update' });
    const changed = closeTimeEntry(e, T0 + 5 * MIN);
    store.upsert(changed);

    expect(store.markSynced(e.id, e)).toBe(false);
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_update' }]);
  });

  it('dirty rows preserve pending_create until remote creation is confirmed', () => {
    const db = new Database(':memory:');
    const store = new SqliteEntryStore(db);
    const e = entry();
    store.upsert(e, { syncState: 'pending_create' });

    const closed = closeTimeEntry(e, T0 + 10 * MIN);

    expect(store.upsert(closed)).toBe('pending_create');
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);
  });

  it('dirty rows become pending_update after remote creation is confirmed', () => {
    const db = new Database(':memory:');
    const store = new SqliteEntryStore(db);
    const e = entry();
    store.upsert(e, { syncState: 'pending_create' });
    store.markCreated(e.id);

    const closed = closeTimeEntry(e, T0 + 10 * MIN);

    expect(store.upsert(closed)).toBe('pending_update');
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_update' }]);
  });

  it('migrates old synced rows to synced', () => {
    const db = new Database(':memory:');
    oldSchema(db);
    const e = entry('old_synced');
    db.prepare(`INSERT INTO local_entries (id, client_uuid, ended_at, synced, json) VALUES (?, ?, ?, 1, ?)`).run(
      e.id,
      e.clientUuid,
      e.endedAt,
      JSON.stringify(e),
    );

    const store = new SqliteEntryStore(db);

    expect(store.getUnsynced()).toHaveLength(0);
  });

  it('migrates old unsynced rows to pending_create', () => {
    const db = new Database(':memory:');
    oldSchema(db);
    const e = entry('old_unsynced');
    db.prepare(`INSERT INTO local_entries (id, client_uuid, ended_at, synced, json) VALUES (?, ?, ?, 0, ?)`).run(
      e.id,
      e.clientUuid,
      e.endedAt,
      JSON.stringify(e),
    );

    const store = new SqliteEntryStore(db);

    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);
  });

  it('persists exit intent, away state, and recovery notice metadata', () => {
    const db = new Database(':memory:');
    const store = new SqliteEntryStore(db);

    store.setExitIntent({ reason: 'quit', entryId: 'entry_1', observedAt: T0 });
    expect(store.getExitIntent()).toEqual({ reason: 'quit', entryId: 'entry_1', observedAt: T0 });
    store.clearExitIntent();
    expect(store.getExitIntent()).toBeNull();

    store.setAwayState({ reason: 'suspend', entryId: 'entry_1', awayStartedAt: T0 + MIN, observedAt: T0 + 2 * MIN });
    expect(store.getAwayState()).toEqual({
      reason: 'suspend',
      entryId: 'entry_1',
      awayStartedAt: T0 + MIN,
      observedAt: T0 + 2 * MIN,
    });
    store.clearAwayState();
    expect(store.getAwayState()).toBeNull();

    store.setRecoveryNotice({
      reason: 'sleep_stop',
      entryId: 'entry_1',
      recoveredAt: T0 + MIN,
      observedAt: T0 + 2 * MIN,
    });
    expect(store.getRecoveryNotice()).toEqual({
      reason: 'sleep_stop',
      entryId: 'entry_1',
      recoveredAt: T0 + MIN,
      observedAt: T0 + 2 * MIN,
    });
    store.clearRecoveryNotice();
    expect(store.getRecoveryNotice()).toBeNull();
  });
});
