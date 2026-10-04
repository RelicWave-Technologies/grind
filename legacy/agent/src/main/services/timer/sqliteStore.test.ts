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
    userId: 'user-1',
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
  function ownedStore(db: Database.Database): SqliteEntryStore {
    const store = new SqliteEntryStore(db);
    store.bindOwner({ userId: 'user-1', workspaceId: 'workspace-1' });
    return store;
  }

  it('stores new rows as pending_create and marks synced rows clean', () => {
    const db = new Database(':memory:');
    const store = ownedStore(db);
    const e = entry();

    expect(store.upsert(e)).toBe('pending_create');
    expect(store.isPendingCreate(e.id)).toBe(true);
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);

    store.markSynced(e.id, e, { revision: e.revision, hash: 'a'.repeat(64) });
    expect(store.isPendingCreate(e.id)).toBe(false);
    expect(store.getUnsynced()).toHaveLength(0);
  });

  it('does not mark synced when the local snapshot changed during sync', () => {
    const db = new Database(':memory:');
    const store = ownedStore(db);
    const e = entry();
    store.upsert(e, { syncState: 'pending_update' });
    const changed = closeTimeEntry(e, T0 + 5 * MIN);
    store.upsert(changed);

    expect(store.markSynced(e.id, e, { revision: e.revision, hash: 'a'.repeat(64) })).toBe(false);
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_update' }]);
  });

  it('does not let an old create response downgrade a newer local snapshot', () => {
    const db = new Database(':memory:');
    const store = ownedStore(db);
    const original = entry();
    store.upsert(original, { syncState: 'pending_create' });
    const changed = closeTimeEntry(original, T0 + 5 * MIN);
    store.upsert(changed);

    expect(store.markCreated(original.id, original)).toBe(false);
    expect(store.getUnsynced()).toMatchObject([{ entry: { revision: changed.revision }, syncState: 'pending_create' }]);
  });

  it('dirty rows preserve pending_create until remote creation is confirmed', () => {
    const db = new Database(':memory:');
    const store = ownedStore(db);
    const e = entry();
    store.upsert(e, { syncState: 'pending_create' });

    const closed = closeTimeEntry(e, T0 + 10 * MIN);

    expect(store.upsert(closed)).toBe('pending_create');
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);
  });

  it('dirty rows become pending_update after remote creation is confirmed', () => {
    const db = new Database(':memory:');
    const store = ownedStore(db);
    const e = entry();
    store.upsert(e, { syncState: 'pending_create' });
    store.markCreated(e.id, e);

    const closed = closeTimeEntry(e, T0 + 10 * MIN);

    expect(store.upsert(closed)).toBe('pending_update');
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_update' }]);
  });

  it('rolls back the old-task close when the replacement task cannot persist', () => {
    const db = new Database(':memory:');
    const store = ownedStore(db);
    const old = entry('old-task');
    const collision = closeTimeEntry(entry('existing-client'), T0 + MIN);
    store.upsert(old);
    store.upsert(collision);

    const closed = closeTimeEntry(old, T0 + 5 * MIN);
    const replacement = { ...entry('replacement'), clientUuid: collision.clientUuid };
    expect(() => store.switchEntry(closed, replacement)).toThrow();

    expect(store.listRecent(10).find((item) => item.id === old.id)?.endedAt).toBeNull();
    expect(store.listRecent(10).some((item) => item.id === replacement.id)).toBe(false);
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

    const store = ownedStore(db);
    store.claimUnownedEntries({ userId: 'user-1', workspaceId: 'workspace-1' });

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

    const store = ownedStore(db);
    store.claimUnownedEntries({ userId: 'user-1', workspaceId: 'workspace-1' });

    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);
  });

  it('persists exit intent, away state, and recovery notice metadata', () => {
    const db = new Database(':memory:');
    const store = ownedStore(db);

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

  it('uses FULL durability and never exposes one owner\'s rows to another', () => {
    const db = new Database(':memory:');
    const store = ownedStore(db);
    store.upsert(entry('private-entry'));
    expect(String(db.pragma('synchronous', { simple: true })).toLowerCase()).toBe('2');

    store.bindOwner({ userId: 'user-2', workspaceId: 'workspace-1' });
    expect(store.getOpen()).toBeNull();
    expect(store.getUnsynced()).toEqual([]);

    store.bindOwner({ userId: 'user-1', workspaceId: 'workspace-1' });
    expect(store.getOpen()?.id).toBe('private-entry');
  });

  it('does not infer ownership for ambiguous legacy rows from the current session', () => {
    const db = new Database(':memory:');
    oldSchema(db);
    const legacy = { ...entry('legacy'), userId: 'self' };
    db.prepare(`INSERT INTO local_entries (id, client_uuid, ended_at, synced, json) VALUES (?, ?, ?, 0, ?)`).run(
      legacy.id,
      legacy.clientUuid,
      legacy.endedAt,
      JSON.stringify(legacy),
    );
    const store = ownedStore(db);
    expect(store.getUnsynced()).toEqual([]);

    expect(store.claimUnownedEntries({ userId: 'user-1', workspaceId: 'workspace-1' })).toBe(0);
    expect(store.getUnsynced()).toEqual([]);
  });

  it('claims an unowned legacy row only when it already names the authenticated user', () => {
    const db = new Database(':memory:');
    oldSchema(db);
    const legacy = entry('owned-legacy');
    db.prepare(`INSERT INTO local_entries (id, client_uuid, ended_at, synced, json) VALUES (?, ?, ?, 0, ?)`).run(
      legacy.id,
      legacy.clientUuid,
      legacy.endedAt,
      JSON.stringify(legacy),
    );
    const store = ownedStore(db);

    expect(store.claimUnownedEntries({ userId: 'user-1', workspaceId: 'workspace-1' })).toBe(1);
    expect(store.getUnsynced()[0]?.entry.userId).toBe('user-1');
  });

  it('claims an unknown row only when the server proves its exact id and client UUID', () => {
    const db = new Database(':memory:');
    oldSchema(db);
    const legacy = { ...closeTimeEntry(entry('server-proven'), T0 + MIN), userId: 'self' };
    db.prepare(`INSERT INTO local_entries (id, client_uuid, ended_at, synced, json) VALUES (?, ?, ?, 0, ?)`).run(
      legacy.id,
      legacy.clientUuid,
      legacy.endedAt,
      JSON.stringify(legacy),
    );
    const store = ownedStore(db);
    const owner = { userId: 'user-1', workspaceId: 'workspace-1' };

    expect(store.claimServerMatchedEntries(owner, [{ id: legacy.id, clientUuid: 'wrong-client' }])).toBe(0);
    expect(store.getUnsynced()).toEqual([]);
    expect(store.claimServerMatchedEntries(owner, [{ id: legacy.id, clientUuid: legacy.clientUuid }])).toBe(1);
    expect(store.getUnsynced()[0]?.entry.userId).toBe(owner.userId);
  });
});
