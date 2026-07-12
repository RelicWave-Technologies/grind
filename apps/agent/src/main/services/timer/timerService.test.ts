import { describe, it, expect, beforeEach } from 'vitest';
import type { TimeEntry } from '@grind/core';
import { closeTimeEntry, totalWorkedMs } from '@grind/core';
import { HttpError } from '../apiClient';
import { TimerService } from './timerService';
import { TrackingBlockedError } from '../trackingReadiness';
import type {
  Clock,
  EntryStore,
  IdGen,
  EntrySyncState,
  PendingEntrySyncState,
  SyncClient,
  TimerAwayState,
  TimerExitIntent,
  TimerRecoveryNotice,
  UnsyncedEntry,
} from './types';

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
  syncStates = new Map<string, EntrySyncState>();
  upsert(e: TimeEntry, opts?: { syncState?: PendingEntrySyncState }) {
    const existing = this.syncStates.get(e.id);
    const nextState = opts?.syncState ?? (existing === 'pending_create' ? 'pending_create' : existing ? 'pending_update' : 'pending_create');
    this.entries.set(e.id, structuredClone(e));
    this.syncStates.set(e.id, nextState);
    return nextState;
  }
  getOpen() {
    for (const e of this.entries.values()) if (e.endedAt === null) return structuredClone(e);
    return null;
  }
  getUnsynced(): UnsyncedEntry[] {
    return [...this.entries.values()]
      .map((e) => ({ entry: structuredClone(e), syncState: this.syncStates.get(e.id) ?? 'pending_create' }))
      .filter((r): r is UnsyncedEntry => r.syncState === 'pending_create' || r.syncState === 'pending_update');
  }
  isPendingCreate(id: string) {
    return this.syncStates.get(id) === 'pending_create';
  }
  listRecent(limit: number) {
    return [...this.entries.values()].reverse().slice(0, limit).map((e) => structuredClone(e));
  }
  listSince(since: number) {
    return [...this.entries.values()]
      .filter((e) => e.endedAt === null || e.endedAt >= since)
      .reverse()
      .map((e) => structuredClone(e));
  }
  markCreated(id: string) {
    this.syncStates.set(id, 'pending_update');
  }
  markPendingCreate(id: string) {
    this.syncStates.set(id, 'pending_create');
  }
  markSynced(id: string, expectedEntry?: TimeEntry) {
    if (expectedEntry) {
      const current = this.entries.get(id);
      if (!current || JSON.stringify(current) !== JSON.stringify(expectedEntry)) return false;
    }
    this.syncStates.set(id, 'synced');
    return true;
  }
  liveness: number | null = null;
  setLiveness(ts: number) {
    this.liveness = ts;
  }
  getLiveness() {
    return this.liveness;
  }
  exitIntent: TimerExitIntent | null = null;
  awayState: TimerAwayState | null = null;
  recovery: TimerRecoveryNotice | null = null;
  setExitIntent(intent: TimerExitIntent) {
    this.exitIntent = structuredClone(intent);
  }
  getExitIntent() {
    return this.exitIntent ? structuredClone(this.exitIntent) : null;
  }
  clearExitIntent() {
    this.exitIntent = null;
  }
  setAwayState(state: TimerAwayState) {
    this.awayState = structuredClone(state);
  }
  getAwayState() {
    return this.awayState ? structuredClone(this.awayState) : null;
  }
  clearAwayState() {
    this.awayState = null;
  }
  setRecoveryNotice(notice: TimerRecoveryNotice) {
    this.recovery = structuredClone(notice);
  }
  getRecoveryNotice() {
    return this.recovery ? structuredClone(this.recovery) : null;
  }
  clearRecoveryNotice() {
    this.recovery = null;
  }
}

class SpySync implements SyncClient {
  creates: string[] = [];
  syncs: string[] = [];
  calls: string[] = [];
  failCreateCount = 0;
  failSyncCount = 0;
  notFoundSyncCount = 0;
  async create(e: TimeEntry) {
    if (this.failCreateCount > 0) {
      this.failCreateCount -= 1;
      throw new Error('network down');
    }
    this.creates.push(e.id);
    this.calls.push(`create:${e.id}`);
  }
  async sync(e: TimeEntry) {
    if (this.notFoundSyncCount > 0) {
      this.notFoundSyncCount -= 1;
      throw new HttpError(`/v1/time-entries/${e.id}/sync`, 404, '{"error":"not_found"}');
    }
    if (this.failSyncCount > 0) {
      this.failSyncCount -= 1;
      throw new Error('network down');
    }
    this.syncs.push(e.id);
    this.calls.push(`sync:${e.id}`);
  }
}

let clock: FakeClock;
let ids: SeqIdGen;
let store: MemStore;
let sync: SpySync;
let svc: TimerService;
let shouldBlockAccrual = false;
const allowAccrual = {
  assertCanAccrue: async () => {
    if (shouldBlockAccrual) {
      throw new TrackingBlockedError({
        ready: false,
        checkedAt: new Date(T0).toISOString(),
        screenRecording: 'NEEDS_SETTINGS',
        accessibility: 'READY',
        blockingCapabilities: ['SCREEN_RECORDING'],
      });
    }
  },
};

beforeEach(() => {
  clock = new FakeClock();
  ids = new SeqIdGen();
  store = new MemStore();
  sync = new SpySync();
  shouldBlockAccrual = false;
  svc = new TimerService(store, sync, clock, ids, allowAccrual);
});

describe('TimerService.start', () => {
  it('does not mutate local state when permissions block a new start', async () => {
    shouldBlockAccrual = true;

    await expect(svc.start({ larkTaskGuid: 'task-a' })).rejects.toMatchObject({
      code: 'TRACKING_PERMISSIONS_REQUIRED',
    });

    expect(store.getOpen()).toBeNull();
    expect(sync.creates).toHaveLength(0);
  });

  it('creates a running entry and persists + syncs it', async () => {
    const status = await svc.start({});
    expect(status.state).toBe('RUNNING');
    expect(svc.isRunning()).toBe(true);
    expect(store.getOpen()).not.toBeNull();
    expect(sync.creates).toHaveLength(1);
    expect(sync.syncs).toHaveLength(1);
  });

  it('switches to another task without requiring a stop first', async () => {
    await svc.start({ larkTaskGuid: 'task-a' });
    clock.advance(10 * MIN);

    const status = await svc.start({ larkTaskGuid: 'task-b' });

    expect(status).toMatchObject({ state: 'RUNNING', larkTaskGuid: 'task-b' });
    const entries = [...store.entries.values()];
    expect(entries).toHaveLength(2);
    const oldEntry = entries.find((e) => e.larkTaskGuid === 'task-a')!;
    const newEntry = entries.find((e) => e.larkTaskGuid === 'task-b')!;
    expect(oldEntry.endedAt).toBe(T0 + 10 * MIN);
    expect(totalWorkedMs(oldEntry)).toBe(10 * MIN);
    expect(newEntry.endedAt).toBeNull();
    expect(newEntry.startedAt).toBe(T0 + 10 * MIN);
    expect(store.getOpen()?.larkTaskGuid).toBe('task-b');
    expect(sync.creates).toEqual([oldEntry.id, newEntry.id]);
    expect(sync.syncs).toEqual([oldEntry.id, oldEntry.id, newEntry.id]);
  });

  it('checks permissions before a task switch can close the current entry', async () => {
    await svc.start({ larkTaskGuid: 'task-a' });
    shouldBlockAccrual = true;

    await expect(svc.start({ larkTaskGuid: 'task-b' })).rejects.toMatchObject({
      code: 'TRACKING_PERMISSIONS_REQUIRED',
    });

    expect(svc.status()).toMatchObject({ state: 'RUNNING', larkTaskGuid: 'task-a', paused: false });
    expect(sync.creates).toHaveLength(1);
  });

  it('is a no-op when starting the task that is already running', async () => {
    const first = await svc.start({ larkTaskGuid: 'task-a' });
    clock.advance(3 * MIN);
    const second = await svc.start({ larkTaskGuid: 'task-a' });

    expect(first.state).toBe('RUNNING');
    expect(second).toMatchObject({ state: 'RUNNING', larkTaskGuid: 'task-a', workedMs: 3 * MIN });
    expect(store.entries).toHaveLength(1);
    expect(sync.creates).toHaveLength(1);
    expect(sync.syncs).toHaveLength(1);
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

  it('keeps today worked ms cumulative across stop/start cycles', async () => {
    await svc.start({});
    clock.advance(10 * MIN);
    const stopped = await svc.stop();
    expect(stopped).toMatchObject({ state: 'IDLE', workedMs: 10 * MIN });

    clock.advance(5 * MIN);
    await svc.start({});
    let s = svc.status();
    expect(s.state).toBe('RUNNING');
    if (s.state === 'RUNNING') expect(s.workedMs).toBe(10 * MIN);

    clock.advance(2 * MIN);
    s = svc.status();
    if (s.state === 'RUNNING') expect(s.workedMs).toBe(12 * MIN);
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
    expect(sync.syncs).toEqual([closed.id, closed.id]);
  });

  it('is a no-op when not running', async () => {
    const status = await svc.stop();
    expect(status.state).toBe('IDLE');
    expect(sync.syncs).toHaveLength(0);
  });
});

describe('TimerService.prepareForQuit', () => {
  it('stops an active timer locally and clears the exit intent after persistence', async () => {
    await svc.start({});
    clock.advance(9 * MIN);

    const status = await svc.prepareForQuit('quit');

    expect(status.state).toBe('IDLE');
    expect(store.getOpen()).toBeNull();
    expect(store.getExitIntent()).toBeNull();
    const closed = [...store.entries.values()][0]!;
    expect(closed.endedAt).toBe(T0 + 9 * MIN);
    expect(totalWorkedMs(closed)).toBe(9 * MIN);
  });

  it('quits while paused without adding the paused gap as worked time', async () => {
    await svc.start({});
    clock.advance(5 * MIN);
    await svc.pauseForIdle(clock.now());
    clock.advance(20 * MIN);

    await svc.prepareForQuit('quit');

    const closed = [...store.entries.values()][0]!;
    expect(closed.endedAt).toBe(T0 + 25 * MIN);
    expect(totalWorkedMs(closed)).toBe(5 * MIN);
  });

  it('leaves the closed row pending when quit sync fails', async () => {
    await svc.start({});
    sync.failSyncCount = 1;
    clock.advance(6 * MIN);

    await svc.prepareForQuit('quit');

    const closed = [...store.entries.values()][0]!;
    expect(closed.endedAt).toBe(T0 + 6 * MIN);
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_update' }]);
    expect(store.getExitIntent()).toBeNull();
  });

  it('clears stale exit intent when nothing is running', async () => {
    store.setExitIntent({ reason: 'quit', entryId: 'old', observedAt: clock.now() });

    await svc.prepareForQuit('quit');

    expect(store.getExitIntent()).toBeNull();
  });
});

describe('TimerService.prepareForAway', () => {
  it('stops a running timer at sleep start and records a sleep notice', async () => {
    await svc.start({});
    clock.advance(5 * MIN);

    const status = await svc.prepareForAway('suspend', clock.now());

    expect(status.state).toBe('IDLE');
    expect(store.getOpen()).toBeNull();
    expect(store.getAwayState()).toBeNull();
    const closed = [...store.entries.values()][0]!;
    expect(closed.endedAt).toBe(T0 + 5 * MIN);
    expect(totalWorkedMs(closed)).toBe(5 * MIN);
    expect(store.getRecoveryNotice()).toMatchObject({
      entryId: closed.id,
      recoveredAt: T0 + 5 * MIN,
      reason: 'sleep_stop',
    });
  });

  it('stops a paused timer without counting the away gap', async () => {
    await svc.start({});
    clock.advance(5 * MIN);
    await svc.pauseForIdle(clock.now());
    clock.advance(20 * MIN);

    await svc.prepareForAway('lock', clock.now());

    const closed = [...store.entries.values()][0]!;
    expect(closed.endedAt).toBe(T0 + 25 * MIN);
    expect(totalWorkedMs(closed)).toBe(5 * MIN);
    expect(store.getRecoveryNotice()).toMatchObject({
      entryId: closed.id,
      recoveredAt: T0 + 25 * MIN,
      reason: 'lock_stop',
    });
  });

  it('leaves the closed row pending when sleep-stop sync fails', async () => {
    await svc.start({});
    sync.failSyncCount = 1;
    clock.advance(6 * MIN);

    await svc.prepareForAway('suspend', clock.now());

    const closed = [...store.entries.values()][0]!;
    expect(closed.endedAt).toBe(T0 + 6 * MIN);
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_update' }]);
    expect(store.getAwayState()).toBeNull();
  });

  it('is a no-op when away fires while idle', async () => {
    store.setAwayState({ reason: 'suspend', entryId: 'old', awayStartedAt: clock.now(), observedAt: clock.now() });

    const status = await svc.prepareForAway('suspend', clock.now());

    expect(status.state).toBe('IDLE');
    expect(store.getAwayState()).toBeNull();
    expect(store.getRecoveryNotice()).toBeNull();
  });
});

describe('TimerService offline behaviour', () => {
  it('keeps the timer working when create sync fails, and retries via flush', async () => {
    sync.failCreateCount = 1; // the create POST fails
    await svc.start({});
    expect(svc.isRunning()).toBe(true); // timer unaffected by network
    expect(sync.creates).toHaveLength(0);
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);

    // Network recovers; flush retries.
    await svc.flushUnsynced();
    expect(sync.creates).toHaveLength(1);
    expect(sync.syncs).toHaveLength(1);
    expect(store.getUnsynced()).toHaveLength(0);
  });

  it('creates then closes an entry that was started and stopped offline', async () => {
    sync.failCreateCount = 2;
    await svc.start({});
    clock.advance(10 * MIN);
    await svc.stop();
    const entry = [...store.entries.values()][0]!;
    expect(entry.endedAt).toBe(T0 + 10 * MIN);
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);

    await svc.flushUnsynced();

    expect(sync.calls).toEqual([`create:${entry.id}`, `sync:${entry.id}`]);
    expect(store.getUnsynced()).toHaveLength(0);
  });

  it('downgrades a pending update that 404s and recreates it once', async () => {
    await svc.start({});
    const entry = store.getOpen()!;
    expect(store.getUnsynced()).toHaveLength(0);

    clock.advance(5 * MIN);
    sync.notFoundSyncCount = 1;
    await svc.pauseForIdle(clock.now());

    expect(sync.calls.slice(-2)).toEqual([`create:${entry.id}`, `sync:${entry.id}`]);
    expect(store.getUnsynced()).toHaveLength(0);
  });

  it('keeps pending_update when create succeeds but follow-up sync fails', async () => {
    sync.failCreateCount = 1;
    await svc.start({});
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);

    sync.failSyncCount = 1;
    await svc.flushUnsynced();

    expect(sync.creates).toHaveLength(1);
    expect(sync.syncs).toHaveLength(0);
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_update' }]);

    await svc.flushUnsynced();
    expect(sync.syncs).toHaveLength(1);
    expect(store.getUnsynced()).toHaveLength(0);
  });

  it('does not upgrade a pending_create row to pending_update when mutated locally', async () => {
    sync.failCreateCount = 2;
    await svc.start({});
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);

    clock.advance(5 * MIN);
    await svc.pauseForIdle(clock.now());

    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_create' }]);
    expect(sync.syncs).toHaveLength(0);
  });

  it('does not mark a newer local mutation synced when an older update finishes', async () => {
    await svc.start({});
    const originalSync = sync.sync.bind(sync);
    sync.sync = async (e) => {
      store.upsert({
        ...e,
        segments: [{ ...e.segments[0]!, endedAt: T0 + 2 * MIN }],
      });
      await originalSync(e);
    };

    clock.advance(1 * MIN);
    await svc.pauseForIdle(clock.now());

    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_update' }]);
  });

  it('leaves stale create-plus-sync rows pending_update when local state changes after create', async () => {
    sync.failCreateCount = 1;
    await svc.start({});
    const entry = store.getOpen()!;
    const originalCreate = sync.create.bind(sync);
    sync.create = async (e) => {
      await originalCreate(e);
      store.upsert({
        ...entry,
        segments: [{ ...entry.segments[0]!, endedAt: T0 + 3 * MIN }],
      });
    };

    await svc.flushUnsynced();

    expect(sync.creates).toHaveLength(1);
    expect(sync.syncs).toHaveLength(1);
    expect(store.getUnsynced()).toMatchObject([{ syncState: 'pending_update' }]);
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
  it('freezes at the last healthy proof and records a permission pause', async () => {
    await svc.start({});
    clock.advance(5 * MIN);
    const lastHealthyAt = clock.now();
    clock.advance(2 * MIN);

    const paused = await svc.pauseForPermission(lastHealthyAt);

    expect(paused).toMatchObject({
      state: 'RUNNING',
      paused: true,
      pauseReason: 'PERMISSION_REQUIRED',
      workedMs: 5 * MIN,
    });
    clock.advance(10 * MIN);
    expect(svc.status()).toMatchObject({ workedMs: 5 * MIN });
  });

  it('cannot resume a permission pause until the accrual guard is ready', async () => {
    await svc.start({});
    clock.advance(MIN);
    await svc.pauseForPermission(clock.now());
    shouldBlockAccrual = true;

    await expect(svc.resume()).rejects.toMatchObject({ code: 'TRACKING_PERMISSIONS_REQUIRED' });
    expect(svc.status()).toMatchObject({ paused: true, pauseReason: 'PERMISSION_REQUIRED' });

    shouldBlockAccrual = false;
    await svc.resume();
    expect(svc.status()).toMatchObject({ paused: false, pauseReason: null });
  });

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

  it('resume is idempotent and only opens a segment when paused', async () => {
    const idle = await svc.resume();
    expect(idle.state).toBe('IDLE');
    expect(sync.syncs).toHaveLength(0);

    await svc.start({});
    clock.advance(2 * MIN);
    const alreadyRunning = await svc.resume();
    expect(alreadyRunning).toMatchObject({ state: 'RUNNING', workedMs: 2 * MIN, paused: false });
    expect(sync.syncs).toHaveLength(1);

    await svc.pauseForIdle(clock.now());
    clock.advance(8 * MIN);
    const resumed = await svc.resume();
    expect(resumed).toMatchObject({ state: 'RUNNING', workedMs: 2 * MIN, paused: false });
    expect(sync.syncs).toHaveLength(3); // start + pause + resume

    clock.advance(3 * MIN);
    const after = svc.status();
    if (after.state === 'RUNNING') expect(after.workedMs).toBe(5 * MIN);
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
  it('recovers durable sleep state before generic crash recovery', async () => {
    await svc.start({});
    clock.advance(8 * MIN);
    const open = store.getOpen()!;
    store.setAwayState({ reason: 'suspend', entryId: open.id, awayStartedAt: clock.now(), observedAt: clock.now() });
    clock.advance(60 * MIN);

    const rebooted = new TimerService(store, sync, clock, ids, allowAccrual);
    const result = rebooted.recoverAway();

    expect(result).toMatchObject({ entryId: open.id, recoveredAt: T0 + 8 * MIN });
    expect(store.getAwayState()).toBeNull();
    const recovered = [...store.entries.values()][0]!;
    expect(recovered.endedAt).toBe(T0 + 8 * MIN);
    expect(totalWorkedMs(recovered)).toBe(8 * MIN);
    expect(store.getRecoveryNotice()).toMatchObject({
      entryId: open.id,
      recoveredAt: T0 + 8 * MIN,
      reason: 'sleep_stop',
    });
  });

  it('clears stale away state for an already-closed entry and creates a lock notice', async () => {
    await svc.start({});
    clock.advance(4 * MIN);
    const open = store.getOpen()!;
    store.upsert(closeTimeEntry(open, clock.now()));
    store.setAwayState({ reason: 'lock', entryId: open.id, awayStartedAt: clock.now(), observedAt: clock.now() });

    const rebooted = new TimerService(store, sync, clock, ids, allowAccrual);
    const result = rebooted.recoverAway();

    expect(result).toMatchObject({ entryId: open.id, recoveredAt: T0 + 4 * MIN });
    expect(store.getAwayState()).toBeNull();
    expect(store.getOpen()).toBeNull();
    expect(store.getRecoveryNotice()).toMatchObject({
      entryId: open.id,
      recoveredAt: T0 + 4 * MIN,
      reason: 'lock_stop',
    });
  });

  it('closes a left-open entry at last-known-active and records a recovery notice', async () => {
    // Simulate a crash: persist an open entry, then build a fresh service.
    await svc.start({});
    const lastActive = clock.now() + 3 * MIN;

    const svc2 = new TimerService(store, sync, clock, ids, allowAccrual);
    const result = svc2.recover(lastActive);

    expect(result).toMatchObject({ entryId: expect.any(String), recoveredAt: lastActive });
    expect(svc2.isRunning()).toBe(false);
    expect(store.getOpen()).toBeNull();
    const recovered = [...store.entries.values()][0]!;
    expect(recovered.endedAt).toBe(lastActive);
    expect(totalWorkedMs(recovered)).toBe(3 * MIN);
    expect(store.getRecoveryNotice()).toMatchObject({
      entryId: recovered.id,
      recoveredAt: lastActive,
      reason: 'unexpected_shutdown',
    });
  });

  it('does nothing when there is no open entry', () => {
    expect(svc.recover(clock.now())).toBeNull();
    expect(svc.isRunning()).toBe(false);
  });

  it('never recovers a paused entry before its latest segment end', async () => {
    await svc.start({});
    clock.advance(10 * MIN);
    await svc.pauseForIdle(clock.now());
    const staleLiveness = T0 + 5 * MIN;

    const rebooted = new TimerService(store, sync, clock, ids, allowAccrual);
    const result = rebooted.recover(staleLiveness);

    expect(result?.recoveredAt).toBe(T0 + 10 * MIN);
    const recovered = [...store.entries.values()][0]!;
    expect(recovered.endedAt).toBe(T0 + 10 * MIN);
    expect(totalWorkedMs(recovered)).toBe(10 * MIN);
  });

  it('dismisses recovery notices', async () => {
    await svc.start({});
    svc.recover(clock.now());

    expect(svc.recoveryNotice()).not.toBeNull();
    svc.dismissRecoveryNotice();
    expect(svc.recoveryNotice()).toBeNull();
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

    const rebooted = new TimerService(store, sync, clock, ids, allowAccrual);
    rebooted.recover(rebooted.lastLiveness() ?? clock.now());

    const recovered = [...store.entries.values()][0]!;
    expect(recovered.endedAt).toBe(lastAlive);
    expect(totalWorkedMs(recovered)).toBe(5 * MIN); // the dead hour is gone
  });

  it('falls back to now() when liveness was never written', async () => {
    await svc.start({});
    clock.advance(3 * MIN);
    // No heartbeat ever fired → lastLiveness null → caller uses now().
    const rebooted = new TimerService(store, sync, clock, ids, allowAccrual);
    expect(rebooted.lastLiveness()).toBeNull();
    rebooted.recover(rebooted.lastLiveness() ?? clock.now());
    const recovered = [...store.entries.values()][0]!;
    expect(recovered.endedAt).toBe(clock.now());
  });
});

describe('TimerService server finalization', () => {
  it('stops the matching local timer, marks it synced, and records a visible notice', async () => {
    const clock = new FakeClock();
    const store = new MemStore();
    const svc = new TimerService(store, new SpySync(), clock, new SeqIdGen(), allowAccrual);
    const running = await svc.start({ larkTaskGuid: 'task' });
    expect(running.state).toBe('RUNNING');
    if (running.state !== 'RUNNING') throw new Error('expected running timer');

    clock.advance(2 * MIN);
    const status = svc.acceptServerFinalization(running.entryId, clock.now());

    expect(status.state).toBe('IDLE');
    expect(store.getOpen()).toBeNull();
    expect(store.getUnsynced()).toEqual([]);
    expect(svc.recoveryNotice()).toMatchObject({
      entryId: running.entryId,
      reason: 'server_finalized',
      recoveredAt: clock.now(),
    });
  });
});
