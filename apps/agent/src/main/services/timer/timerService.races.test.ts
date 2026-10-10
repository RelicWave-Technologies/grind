import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeTimeEntry, createTimeEntry, type TimeEntry } from '@grind/core';
import { SqliteEntryStore } from './sqliteStore';
import { TimerService } from './timerService';
import type { Clock, IdGen, SyncClient, TimerOwner } from './types';

/** Commands that interleave across the permission check, and what they leave behind. */

const T0 = Date.UTC(2026, 9, 10, 2, 0, 0);
const MIN = 60_000;
const OWNER: TimerOwner = { userId: 'user-1', workspaceId: 'w1' };

class FakeClock implements Clock {
  t = T0;
  now() { return this.t; }
}

class SeqIds implements IdGen {
  private n = 0;
  ulid() {
    this.n += 1;
    return `id_${String(this.n).padStart(6, '0')}`;
  }
}

const offline: SyncClient = {
  create: async () => { throw new Error('offline'); },
  sync: async () => { throw new Error('offline'); },
};

/** A permission check that waits until the test lets it through. */
class GatedGuard {
  private gates: Array<() => void> = [];
  assertCanAccrue = () => new Promise<void>((resolve) => { this.gates.push(resolve); });
  releaseAll() {
    for (const release of this.gates.splice(0)) release();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let db: Database.Database;
let store: SqliteEntryStore;
let clock: FakeClock;
let guard: GatedGuard;
let svc: TimerService;

beforeEach(() => {
  db = new Database(':memory:');
  store = new SqliteEntryStore(db);
  clock = new FakeClock();
  guard = new GatedGuard();
  svc = new TimerService(store, offline, clock, new SeqIds(), guard);
  svc.bindOwner(OWNER);
});

describe('commands racing across the permission check', () => {
  it('a resume that loses the race to a stop does nothing instead of throwing', async () => {
    const starting = svc.start({});
    guard.releaseAll();
    await starting;
    await svc.pause();
    clock.t += 5 * MIN;

    const resuming = svc.resume();
    await svc.stop();
    guard.releaseAll();

    await expect(resuming).resolves.toMatchObject({ state: 'IDLE' });
    expect(store.listOpen()).toEqual([]);
  });

  it('two starts that both wait on the check leave exactly one open entry', async () => {
    const first = svc.start({ larkTaskGuid: 'task-a' });
    const second = svc.start({ larkTaskGuid: 'task-b' });
    guard.releaseAll();
    await Promise.all([first, second]);
    await settle();

    const open = store.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.larkTaskGuid).toBe('task-b');
  });
});

describe('boot with more than one open entry', () => {
  function openAt(id: string, startedAt: number): TimeEntry {
    return createTimeEntry({ id, clientUuid: `c_${id}`, userId: OWNER.userId, source: 'AUTO', startedAt, segmentId: `s_${id}` });
  }

  it('closes every open entry but the newest at its last checkpoint, then recovers the newest', () => {
    store.upsert(openAt('older', T0));
    store.upsert(openAt('newer', T0 + 30 * MIN));
    store.setLiveness(T0 + 40 * MIN);
    clock.t = T0 + 5 * 60 * MIN;

    // A new process: a fresh store on the same database, bound at boot.
    const rebooted = new TimerService(new SqliteEntryStore(db), offline, clock, new SeqIds(), guard);
    rebooted.switchOwner(OWNER);

    expect(store.listOpen()).toEqual([]);
    const byId = new Map(store.listLedgerEntries(0).map((row) => [row.entry.id, row.entry]));
    // Never past the start of the entry after it: one timer runs at a time.
    expect(byId.get('older')).toMatchObject({ endedAt: T0 + 30 * MIN, closeReason: 'AGENT_RECOVERY' });
    expect(byId.get('newer')).toMatchObject({ endedAt: T0 + 40 * MIN, closeReason: 'AGENT_RECOVERY' });
  });
});

describe('the one-time resend of entries the server cut short', () => {
  it('is all-or-nothing: a crash part-way neither skips the rest nor marks the pass done', () => {
    for (const id of ['a', 'b']) {
      const closed = closeTimeEntry(
        createTimeEntry({ id, clientUuid: `c_${id}`, userId: OWNER.userId, source: 'AUTO', startedAt: T0, segmentId: `s_${id}` }),
        T0 + 10 * MIN,
      );
      store.upsert(closed);
      store.markSynced(id, closed, { revision: closed.revision, hash: 'server-copy-was-shorter' });
    }
    clock.t = T0 + 60 * MIN;
    const realUpsert = store.upsert.bind(store);
    let writes = 0;
    store.upsert = (...args) => {
      writes += 1;
      if (writes === 2) throw new Error('disk I/O error');
      return realUpsert(...args);
    };

    expect(() => svc.resyncTruncatedOnce()).toThrow('disk I/O error');
    expect(store.listLedgerEntries(0).every((row) => row.syncState === 'synced')).toBe(true);

    store.upsert = realUpsert;
    expect(svc.resyncTruncatedOnce()).toBe(2);
    expect(svc.resyncTruncatedOnce()).toBe(0);
  });
});
