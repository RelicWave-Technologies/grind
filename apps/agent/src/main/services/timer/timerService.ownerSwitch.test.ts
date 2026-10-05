import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TimeEntry } from '@grind/core';
import { SqliteEntryStore } from './sqliteStore';
import { TimerService } from './timerService';
import type { Clock, IdGen, SyncClient, TimerOwner } from './types';

/**
 * Account switches on one machine (data isolation, timer half).
 *
 * Runs against the real SQLite store: owner scoping lives there, and a fake
 * store that ignores the owner would hide exactly the bug under test — user
 * A's open entry surviving B's session and being resumed over the gap.
 */

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const ALICE: TimerOwner = { userId: 'alice', workspaceId: 'w1' };
const BOB: TimerOwner = { userId: 'bob', workspaceId: 'w1' };

class FakeClock implements Clock {
  constructor(public t = T0) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

class SeqIds implements IdGen {
  private n = 0;
  ulid() {
    this.n += 1;
    return `id_${String(this.n).padStart(6, '0')}`;
  }
}

/** Offline server that records which user each push belonged to. */
class RecordingSync implements SyncClient {
  pushedUserIds: string[] = [];
  async create(entry: TimeEntry): Promise<never> {
    this.pushedUserIds.push(entry.userId);
    throw new Error('offline');
  }
  async sync(entry: TimeEntry): Promise<never> {
    this.pushedUserIds.push(entry.userId);
    throw new Error('offline');
  }
}

const allowAccrual = { assertCanAccrue: async () => undefined };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let db: Database.Database;
let clock: FakeClock;
let sync: RecordingSync;

function service(): TimerService {
  return new TimerService(new SqliteEntryStore(db), sync, clock, new SeqIds(), allowAccrual);
}

function rowFor(svc: TimerService, owner: TimerOwner, entryId: string): TimeEntry | undefined {
  svc.bindOwner(owner);
  return (svc as unknown as { store: SqliteEntryStore }).store
    .listLedgerEntries(0)
    .map((row) => row.entry)
    .find((entry) => entry.id === entryId);
}

beforeEach(() => {
  db = new Database(':memory:');
  clock = new FakeClock();
  sync = new RecordingSync();
});

describe('TimerService.switchOwner', () => {
  it("closes the previous owner's running entry at its last proof of life before binding the next", async () => {
    const svc = service();
    svc.switchOwner(ALICE);
    await svc.start({});
    const aliceEntry = svc.status();
    if (aliceEntry.state !== 'RUNNING') throw new Error('expected running');
    clock.advance(10 * MIN);
    svc.heartbeat(); // last liveness while Alice was really accruing
    clock.advance(50 * MIN);

    const recovered = svc.switchOwner(BOB);

    expect(recovered).toMatchObject([{ entryId: aliceEntry.entryId, recoveredAt: T0 + 10 * MIN }]);
    expect(svc.currentOwner()).toEqual(BOB);
    expect(svc.isRunning()).toBe(false);
  });

  it('never resumes the old entry over the gap when the first user signs back in', async () => {
    const svc = service();
    svc.switchOwner(ALICE);
    await svc.start({});
    const entryId = (svc.status() as { entryId: string }).entryId;
    clock.advance(5 * MIN);
    svc.heartbeat();
    svc.switchOwner(BOB);
    clock.advance(3 * 60 * MIN); // Bob's afternoon

    svc.switchOwner(ALICE);

    expect(svc.isRunning()).toBe(false);
    const stored = rowFor(svc, ALICE, entryId)!;
    expect(stored.endedAt).toBe(T0 + 5 * MIN);
    expect(stored.closeReason).toBe('AGENT_RECOVERY');
  });

  it("never uploads the previous owner's entry under the next owner's session", async () => {
    const svc = service();
    svc.switchOwner(ALICE);
    await svc.start({});
    await settle();
    clock.advance(MIN);
    svc.heartbeat();
    sync.pushedUserIds = [];

    svc.switchOwner(BOB);
    await svc.flushUnsynced(Number.POSITIVE_INFINITY);
    await settle();

    expect(sync.pushedUserIds).not.toContain('alice');
    // Still queued for Alice, to upload when she signs in again.
    svc.switchOwner(ALICE);
    expect(svc.hasUnsynced()).toBe(true);
  });

  it('closes an entry the incoming owner left open in an earlier run', async () => {
    const before = service();
    before.switchOwner(BOB);
    await before.start({});
    clock.advance(2 * MIN);
    before.heartbeat();
    // The process dies here. A new one starts signed out, then Bob signs in.
    clock.advance(8 * 60 * MIN);
    const after = service();
    after.switchOwner(null);

    const recovered = after.switchOwner(BOB);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.recoveredAt).toBe(T0 + 2 * MIN);
    expect(after.isRunning()).toBe(false);
  });

  it('leaves a running timer alone when the same owner is bound again', async () => {
    const svc = service();
    svc.switchOwner(ALICE);
    await svc.start({});
    clock.advance(MIN);

    expect(svc.switchOwner({ ...ALICE })).toEqual([]);
    expect(svc.isRunning()).toBe(true);
  });
});

describe('TimerService.resyncFromServer', () => {
  it('does not push an open entry this process never accrued', async () => {
    const before = service();
    before.switchOwner(ALICE);
    await before.start({});
    await settle();
    const entry = (before.status() as { entryId: string; revision: number });
    // The unsafe path an older build took: bind without recovery.
    const after = service();
    after.bindOwner(ALICE);
    sync.pushedUserIds = [];

    await after.resyncFromServer(entry.entryId, entry.revision + 3);
    await settle();

    expect(sync.pushedUserIds).toEqual([]);
    expect(rowFor(after, ALICE, entry.entryId)!.revision).toBe(entry.revision);
  });

  it('closes at the last proof of life instead of resending over a server close it cannot cover', async () => {
    const svc = service();
    svc.switchOwner(ALICE);
    await svc.start({});
    const { entryId, revision } = svc.status() as { entryId: string; revision: number };
    clock.advance(5 * MIN);
    svc.heartbeat();
    const provenAliveAt = svc.lastLiveness();
    clock.advance(60 * MIN); // asleep without the away handler noticing

    await svc.resyncFromServer(entryId, revision, { serverEndedAt: T0 + 8 * MIN, provenAliveAt });

    expect(svc.isRunning()).toBe(false);
    expect(rowFor(svc, ALICE, entryId)!.endedAt).toBe(T0 + 5 * MIN);
  });

  it('still resends an entry it was accruing through the server close', async () => {
    const svc = service();
    svc.switchOwner(ALICE);
    await svc.start({});
    const { entryId, revision } = svc.status() as { entryId: string; revision: number };
    clock.advance(20 * MIN);
    svc.heartbeat();

    await svc.resyncFromServer(entryId, revision, { serverEndedAt: T0 + 8 * MIN, provenAliveAt: svc.lastLiveness() });

    expect(svc.isRunning()).toBe(true);
    expect((svc.status() as { revision: number }).revision).toBe(revision + 1);
  });
});
