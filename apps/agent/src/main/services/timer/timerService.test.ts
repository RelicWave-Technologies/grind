import { describe, it, expect, beforeEach } from 'vitest';
import type { TimeEntry } from '@grind/core';
import { totalWorkedMs } from '@grind/core';
import { TimerService } from './timerService';
import type { Clock, EntryStore, IdGen, SyncClient } from './types';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

class FakeClock implements Clock {
  constructor(public t = T0) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

class SeqIdGen implements IdGen {
  private n = 0;
  ulid() {
    this.n += 1;
    return `id_${String(this.n).padStart(6, '0')}`;
  }
}

class MemStore implements EntryStore {
  entries = new Map<string, TimeEntry>();
  synced = new Set<string>();
  upsert(e: TimeEntry) {
    this.entries.set(e.id, structuredClone(e));
    this.synced.delete(e.id); // any change marks it dirty
  }
  getOpen() {
    for (const e of this.entries.values()) if (e.endedAt === null) return structuredClone(e);
    return null;
  }
  getUnsynced() {
    return [...this.entries.values()].filter((e) => !this.synced.has(e.id)).map((e) => structuredClone(e));
  }
  listRecent(limit: number) {
    return [...this.entries.values()].reverse().slice(0, limit).map((e) => structuredClone(e));
  }
  markSynced(id: string) {
    this.synced.add(id);
  }
}

class SpySync implements SyncClient {
  creates: string[] = [];
  syncs: string[] = [];
  failNext = false;
  async create(e: TimeEntry) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('network down');
    }
    this.creates.push(e.id);
  }
  async sync(e: TimeEntry) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('network down');
    }
    this.syncs.push(e.id);
  }
}

let clock: FakeClock;
let ids: SeqIdGen;
let store: MemStore;
let sync: SpySync;
let svc: TimerService;

beforeEach(() => {
  clock = new FakeClock();
  ids = new SeqIdGen();
  store = new MemStore();
  sync = new SpySync();
  svc = new TimerService(store, sync, clock, ids);
});

describe('TimerService.start', () => {
  it('creates a running entry and persists + syncs it', async () => {
    const status = await svc.start({ projectId: 'p1' });
    expect(status.state).toBe('RUNNING');
    expect(svc.isRunning()).toBe(true);
    expect(store.getOpen()).not.toBeNull();
    expect(sync.creates).toHaveLength(1);
  });

  it('rejects starting a second timer while one is running', async () => {
    await svc.start({ projectId: 'p1' });
    await expect(svc.start({ projectId: 'p2' })).rejects.toThrow(/already running/);
  });

  it('attributes project + task', async () => {
    const status = await svc.start({ projectId: 'p1', taskId: 't9' });
    expect(status).toMatchObject({ state: 'RUNNING', projectId: 'p1', taskId: 't9' });
  });
});

describe('TimerService.status worked time', () => {
  it('accrues worked ms as the clock advances', async () => {
    await svc.start({ projectId: 'p1' });
    clock.advance(7 * MIN);
    const s = svc.status();
    expect(s.state).toBe('RUNNING');
    if (s.state === 'RUNNING') expect(s.workedMs).toBe(7 * MIN);
  });
});

describe('TimerService.stop', () => {
  it('closes the entry and returns to IDLE', async () => {
    await svc.start({ projectId: 'p1' });
    clock.advance(10 * MIN);
    const status = await svc.stop();
    expect(status.state).toBe('IDLE');
    expect(svc.isRunning()).toBe(false);
    expect(store.getOpen()).toBeNull();
    // closed entry total = 10 minutes
    const closed = [...store.entries.values()][0]!;
    expect(totalWorkedMs(closed)).toBe(10 * MIN);
    expect(sync.syncs).toHaveLength(1);
  });

  it('is a no-op when not running', async () => {
    const status = await svc.stop();
    expect(status.state).toBe('IDLE');
    expect(sync.syncs).toHaveLength(0);
  });
});

describe('TimerService offline behaviour', () => {
  it('keeps the timer working when create sync fails, and retries via flush', async () => {
    sync.failNext = true; // the create POST fails
    await svc.start({ projectId: 'p1' });
    expect(svc.isRunning()).toBe(true); // timer unaffected by network
    expect(sync.creates).toHaveLength(0);
    expect(store.getUnsynced()).toHaveLength(1);

    // Network recovers; flush retries.
    await svc.flushUnsynced();
    expect(sync.syncs).toHaveLength(1);
    expect(store.getUnsynced()).toHaveLength(0);
  });
});

describe('TimerService.discardAway (sleep/lock)', () => {
  it('trims the away gap and keeps the timer running', async () => {
    await svc.start({ projectId: 'p1' }); // WORK from T0
    clock.advance(5 * MIN); // worked 5 min, then machine sleeps
    const awayStart = clock.now();
    clock.advance(30 * MIN); // asleep 30 min
    await svc.discardAway(awayStart, clock.now());

    expect(svc.isRunning()).toBe(true);
    const s = svc.status();
    if (s.state === 'RUNNING') expect(s.workedMs).toBe(5 * MIN); // sleep not billed
    // resume + a bit more
    clock.advance(2 * MIN);
    const s2 = svc.status();
    if (s2.state === 'RUNNING') expect(s2.workedMs).toBe(7 * MIN);
  });

  it('is a no-op when idle', async () => {
    await svc.discardAway(T0, T0 + 10 * MIN);
    expect(svc.isRunning()).toBe(false);
  });

  it('ignores trivially short gaps', async () => {
    await svc.start({ projectId: 'p1' });
    clock.advance(3 * MIN);
    const before = svc.status();
    await svc.discardAway(clock.now(), clock.now() + 500); // <1s
    const after = svc.status();
    expect(after).toEqual(before);
  });
});

describe('TimerService.recover (crash recovery)', () => {
  it('closes a left-open entry at last-known-active and syncs it', async () => {
    // Simulate a crash: persist an open entry, then build a fresh service.
    await svc.start({ projectId: 'p1' });
    const lastActive = clock.now() + 3 * MIN;

    const svc2 = new TimerService(store, sync, clock, ids);
    svc2.recover(lastActive);

    expect(svc2.isRunning()).toBe(false);
    expect(store.getOpen()).toBeNull();
    const recovered = [...store.entries.values()][0]!;
    expect(recovered.endedAt).toBe(lastActive);
    expect(totalWorkedMs(recovered)).toBe(3 * MIN);
  });

  it('does nothing when there is no open entry', () => {
    svc.recover(clock.now());
    expect(svc.isRunning()).toBe(false);
  });
});
