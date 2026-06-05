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
  liveness: number | null = null;
  setLiveness(ts: number) {
    this.liveness = ts;
  }
  getLiveness() {
    return this.liveness;
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
    const status = await svc.start({});
    expect(status.state).toBe('RUNNING');
    expect(svc.isRunning()).toBe(true);
    expect(store.getOpen()).not.toBeNull();
    expect(sync.creates).toHaveLength(1);
  });

  it('rejects starting a second timer while one is running', async () => {
    await svc.start({});
    await expect(svc.start({})).rejects.toThrow(/already running/);
  });

  it('attributes a Lark task guid and persists it', async () => {
    const status = await svc.start({ larkTaskGuid: 'guid-123' });
    expect(status).toMatchObject({ state: 'RUNNING', larkTaskGuid: 'guid-123' });
    expect(store.getOpen()?.larkTaskGuid).toBe('guid-123');
  });

  it('defaults larkTaskGuid to null when not provided', async () => {
    const status = await svc.start({});
    if (status.state === 'RUNNING') expect(status.larkTaskGuid).toBeNull();
  });
});

describe('TimerService.status worked time', () => {
  it('accrues worked ms as the clock advances', async () => {
    await svc.start({});
    clock.advance(7 * MIN);
    const s = svc.status();
    expect(s.state).toBe('RUNNING');
    if (s.state === 'RUNNING') expect(s.workedMs).toBe(7 * MIN);
  });
});

describe('TimerService.stop', () => {
  it('closes the entry and returns to IDLE', async () => {
    await svc.start({});
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
    await svc.start({});
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
    await svc.start({}); // WORK from T0
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
    await svc.start({});
    clock.advance(3 * MIN);
    const before = svc.status();
    await svc.discardAway(clock.now(), clock.now() + 500); // <1s
    const after = svc.status();
    expect(after).toEqual(before);
  });
});

describe('TimerService.pauseForIdle / resumeFromIdle', () => {
  it('freezes worked time on pause and never counts the idle gap', async () => {
    await svc.start({}); // WORK from T0
    clock.advance(5 * MIN); // worked 5 min
    await svc.pauseForIdle(clock.now());

    expect(svc.isPaused()).toBe(true);
    let s = svc.status();
    expect(s.state === 'RUNNING' && s.paused).toBe(true);
    if (s.state === 'RUNNING') expect(s.workedMs).toBe(5 * MIN);

    // Time passes while paused — worked time stays frozen.
    clock.advance(10 * MIN);
    s = svc.status();
    if (s.state === 'RUNNING') expect(s.workedMs).toBe(5 * MIN);

    // Continue: resume a fresh WORK segment; idle gap excluded.
    await svc.resumeFromIdle(clock.now());
    expect(svc.isPaused()).toBe(false);
    clock.advance(3 * MIN);
    s = svc.status();
    if (s.state === 'RUNNING') expect(s.workedMs).toBe(8 * MIN); // 5 + 3, not the 10 idle
  });

  it('clamps pause time to the segment start (whole-segment idle)', async () => {
    await svc.start({});
    clock.advance(2 * MIN);
    await svc.pauseForIdle(T0 - 10 * MIN); // idleStart before segment start
    const s = svc.status();
    if (s.state === 'RUNNING') expect(s.workedMs).toBe(0); // clamped → zero worked
  });

  it('break (stop) after pause finalizes at the frozen time', async () => {
    await svc.start({});
    clock.advance(7 * MIN);
    await svc.pauseForIdle(clock.now());
    clock.advance(20 * MIN); // away
    await svc.stop();
    expect(svc.isRunning()).toBe(false);
    const entry = [...store.entries.values()][0]!;
    expect(totalWorkedMs(entry)).toBe(7 * MIN); // away time not billed
  });

  it('pause is a no-op when idle or already paused', async () => {
    await svc.pauseForIdle(T0); // not running
    expect(svc.isRunning()).toBe(false);
    await svc.start({});
    await svc.pauseForIdle(clock.now());
    const before = svc.status();
    await svc.pauseForIdle(clock.now()); // already paused
    expect(svc.status()).toEqual(before);
  });
});

describe('TimerService meeting segments', () => {
  it('switches WORK→MEETING→WORK and counts both as worked', async () => {
    await svc.start({}); // WORK from T0
    clock.advance(5 * MIN);
    await svc.beginMeeting(clock.now()); // MEETING from T0+5
    expect(svc.isInMeetingSegment()).toBe(true);
    clock.advance(20 * MIN);
    await svc.endMeeting(clock.now()); // WORK from T0+25
    expect(svc.isInMeetingSegment()).toBe(false);
    clock.advance(3 * MIN);
    const s = svc.status();
    if (s.state === 'RUNNING') expect(s.workedMs).toBe(28 * MIN); // 5 + 20 + 3, all counted
  });

  it('beginMeeting is a no-op when not running or already in a meeting', async () => {
    await svc.beginMeeting(clock.now()); // not running
    expect(svc.isRunning()).toBe(false);
    await svc.start({});
    await svc.beginMeeting(clock.now());
    const before = svc.status();
    await svc.beginMeeting(clock.now()); // already meeting
    expect(svc.status()).toEqual(before);
  });

  it('endMeeting is a no-op when not in a meeting', async () => {
    await svc.start({});
    const before = svc.status();
    await svc.endMeeting(clock.now());
    expect(svc.status()).toEqual(before);
  });
});

describe('TimerService.recover (crash recovery)', () => {
  it('closes a left-open entry at last-known-active and syncs it', async () => {
    // Simulate a crash: persist an open entry, then build a fresh service.
    await svc.start({});
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

describe('TimerService liveness (crash-recovery bound)', () => {
  it('heartbeat persists the current time while an entry is open', async () => {
    await svc.start({});
    clock.advance(42 * 1000);
    svc.heartbeat();
    expect(store.getLiveness()).toBe(clock.now());
    expect(svc.lastLiveness()).toBe(clock.now());
  });

  it('heartbeat is a no-op when nothing is open', () => {
    svc.heartbeat();
    expect(store.getLiveness()).toBeNull();
  });

  it('boot recovery closes a dangling entry at the last liveness tick, not "now"', async () => {
    // Work 5 min, last heartbeat at +5min, then the machine hard-dies and the
    // app reboots an hour later. The dead hour must NOT be credited.
    await svc.start({});
    clock.advance(5 * MIN);
    svc.heartbeat();
    const lastAlive = clock.now();
    clock.advance(60 * MIN); // an hour of being powered off

    const rebooted = new TimerService(store, sync, clock, ids);
    rebooted.recover(rebooted.lastLiveness() ?? clock.now());

    const recovered = [...store.entries.values()][0]!;
    expect(recovered.endedAt).toBe(lastAlive);
    expect(totalWorkedMs(recovered)).toBe(5 * MIN); // the dead hour is gone
  });

  it('falls back to now() when liveness was never written', async () => {
    await svc.start({});
    clock.advance(3 * MIN);
    // No heartbeat ever fired → lastLiveness null → caller uses now().
    const rebooted = new TimerService(store, sync, clock, ids);
    expect(rebooted.lastLiveness()).toBeNull();
    rebooted.recover(rebooted.lastLiveness() ?? clock.now());
    const recovered = [...store.entries.values()][0]!;
    expect(recovered.endedAt).toBe(clock.now());
  });
});
