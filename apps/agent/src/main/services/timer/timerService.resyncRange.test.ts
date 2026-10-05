import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeTimeEntry, createTimeEntry, type TimeEntry } from '@grind/core';
import { SqliteEntryStore } from './sqliteStore';
import { TimerService } from './timerService';
import type { Clock, IdGen, LocalLedgerEntry, SyncClient, TimerOwner } from './types';

/**
 * Developer-requested resend of a date range, against the real SQLite store:
 * owner scoping and sync state live there.
 */

const DAY_START = Date.UTC(2026, 9, 5); // 2026-10-05T00:00Z
const DAY_END = DAY_START + 24 * 60 * 60_000;
const MIN = 60_000;
const ALICE: TimerOwner = { userId: 'alice', workspaceId: 'w1' };
const BOB: TimerOwner = { userId: 'bob', workspaceId: 'w1' };

class FakeClock implements Clock {
  constructor(public t = DAY_START + 12 * 60 * MIN) {}
  now() {
    return this.t;
  }
}

class SeqIds implements IdGen {
  private n = 0;
  ulid() {
    this.n += 1;
    return `id_${String(this.n).padStart(6, '0')}`;
  }
}

/** Offline: every push fails, so requeued rows stay visibly pending. */
class OfflineSync implements SyncClient {
  async create(): Promise<never> {
    throw new Error('offline');
  }
  async sync(): Promise<never> {
    throw new Error('offline');
  }
}

const allowAccrual = { assertCanAccrue: async () => undefined };

let db: Database.Database;
let store: SqliteEntryStore;
let svc: TimerService;

function closedEntry(owner: TimerOwner, id: string, startedAt: number, endedAt: number): TimeEntry {
  const open = createTimeEntry({
    id,
    clientUuid: `client_${id}`,
    userId: owner.userId,
    source: 'AUTO',
    startedAt,
    segmentId: `segment_${id}`,
  });
  return closeTimeEntry(open, endedAt);
}

/** Write an entry for `owner` and, unless pending, mark the server's acknowledgement. */
function seed(owner: TimerOwner, entry: TimeEntry, ack: { revision: number } | 'pending_create'): void {
  store.bindOwner(owner);
  store.upsert(entry);
  if (ack !== 'pending_create') {
    store.markCreated(entry.id, entry);
    store.markSynced(entry.id, entry, { revision: ack.revision, hash: 'server-hash' });
  }
}

function row(owner: TimerOwner, id: string): LocalLedgerEntry | undefined {
  store.bindOwner(owner);
  return store.listLedgerEntries(0).find((item) => item.entry.id === id);
}

beforeEach(() => {
  db = new Database(':memory:');
  store = new SqliteEntryStore(db);
  svc = new TimerService(store, new OfflineSync(), new FakeClock(), new SeqIds(), allowAccrual);
});

describe('TimerService.resyncRange', () => {
  it("requeues the owner's closed entries in range with a revision above the server's", () => {
    const inRange = closedEntry(ALICE, 'a_in', DAY_START + 9 * 60 * MIN, DAY_START + 10 * 60 * MIN);
    const notCreated = closedEntry(ALICE, 'a_new', DAY_START + 11 * 60 * MIN, DAY_START + 11 * 60 * MIN + 30 * MIN);
    const straddling = closedEntry(ALICE, 'a_edge', DAY_START - 30 * MIN, DAY_START + 30 * MIN);
    const before = closedEntry(ALICE, 'a_before', DAY_START - 5 * 60 * MIN, DAY_START - 4 * 60 * MIN);
    const after = closedEntry(ALICE, 'a_after', DAY_END + 60 * MIN, DAY_END + 2 * 60 * MIN);
    const bobs = closedEntry(BOB, 'b_in', DAY_START + 9 * 60 * MIN, DAY_START + 10 * 60 * MIN);
    seed(ALICE, inRange, { revision: 7 });
    seed(ALICE, notCreated, 'pending_create');
    seed(ALICE, straddling, { revision: 1 });
    seed(ALICE, before, { revision: 1 });
    seed(ALICE, after, { revision: 1 });
    seed(BOB, bobs, { revision: 1 });

    svc.bindOwner(ALICE);
    const result = svc.resyncRange(DAY_START, DAY_END);

    expect(result).toEqual({ requeued: 3, openRequeued: false });
    const resent = row(ALICE, 'a_in')!;
    expect(resent.syncState).toBe('pending_update');
    // Local revision was 1 (one close); the server had acknowledged 7.
    expect(resent.entry.revision).toBe(8);
    expect(resent.entry.endedAt).toBe(inRange.endedAt);
    expect(row(ALICE, 'a_edge')!.syncState).toBe('pending_update');
    // Never created stays a create, untouched otherwise.
    expect(row(ALICE, 'a_new')).toMatchObject({ syncState: 'pending_create', entry: { revision: notCreated.revision } });
    expect(row(ALICE, 'a_before')!.syncState).toBe('synced');
    expect(row(ALICE, 'a_after')!.syncState).toBe('synced');
    // Another account's entry on the same machine is never touched.
    expect(row(BOB, 'b_in')).toMatchObject({ syncState: 'synced', entry: { revision: bobs.revision } });

    store.bindOwner(ALICE);
    expect(svc.rangeBacklog(DAY_START, DAY_END)).toEqual({ pending: 3, lastErrors: [] });
  });

  it('clears backoff so the next drain sends them, and reports their errors', async () => {
    const entry = closedEntry(ALICE, 'a_in', DAY_START + 9 * 60 * MIN, DAY_START + 10 * 60 * MIN);
    seed(ALICE, entry, 'pending_create');
    store.noteSyncFailure(entry.id, 'http_500:boom', Number.MAX_SAFE_INTEGER);
    svc.bindOwner(ALICE);
    expect(store.getUnsynced(DAY_START + 12 * 60 * MIN)).toHaveLength(0);
    expect(svc.rangeBacklog(DAY_START, DAY_END)).toEqual({ pending: 1, lastErrors: ['http_500:boom'] });

    svc.resyncRange(DAY_START, DAY_END);

    expect(store.getUnsynced(DAY_START + 12 * 60 * MIN).map((r) => r.entry.id)).toEqual(['a_in']);
    await svc.flushUnsynced();
    const backlog = svc.rangeBacklog(DAY_START, DAY_END);
    expect(backlog.pending).toBe(1);
    expect(backlog.lastErrors).toEqual(['Error:offline']);
  });

  it('requeues the running entry, bumping its revision when the server already has it', async () => {
    svc.switchOwner(ALICE);
    await svc.start({});
    const entryId = (svc.status() as { entryId: string }).entryId;
    const open = row(ALICE, entryId)!.entry;
    svc.bindOwner(ALICE);
    store.markCreated(entryId, open);
    store.markSynced(entryId, open, { revision: open.revision, hash: 'server-hash' });

    const result = svc.resyncRange(DAY_START, DAY_END);

    expect(result).toEqual({ requeued: 0, openRequeued: true });
    const after = row(ALICE, entryId)!;
    expect(after.syncState).toBe('pending_update');
    expect(after.entry.revision).toBe(open.revision + 1);
    expect(after.entry.endedAt).toBeNull();
    // Still running, from the bumped copy.
    svc.bindOwner(ALICE);
    expect(svc.isRunning()).toBe(true);
    // The running entry is not part of the closed backlog the resync waits on.
    expect(svc.rangeBacklog(DAY_START, DAY_END).pending).toBe(0);
  });

  it('keeps a running entry that was never created a pending create', async () => {
    svc.switchOwner(ALICE);
    await svc.start({});
    const entryId = (svc.status() as { entryId: string }).entryId;

    expect(svc.resyncRange(DAY_START, DAY_END)).toEqual({ requeued: 0, openRequeued: true });
    expect(row(ALICE, entryId)!.syncState).toBe('pending_create');
  });

  it('refuses without a signed-in owner', () => {
    expect(() => svc.resyncRange(DAY_START, DAY_END)).toThrow('timer_owner_unavailable');
  });

  it('remembers notes and once-marks per owner', () => {
    svc.bindOwner(ALICE);
    expect(svc.markOnce('command:c1')).toBe(true);
    expect(svc.markOnce('command:c1')).toBe(false);
    svc.setNote('command:c1', '{"status":"DONE"}');
    expect(svc.getNote('command:c1')).toBe('{"status":"DONE"}');
    svc.bindOwner(BOB);
    expect(svc.getNote('command:c1')).toBeNull();
    expect(svc.markOnce('command:c1')).toBe(true);
  });
});
