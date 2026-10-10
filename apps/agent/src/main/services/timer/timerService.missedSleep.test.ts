import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalTimerEntryPayload, totalWorkedMs, type TimeEntry, type TimeEntryCloseReason } from '@grind/core';
import type { TimerSyncReceipt } from '@grind/types';
import { SqliteEntryStore } from './sqliteStore';
import { MISSED_SLEEP_GAP_MS, TimerService } from './timerService';
import type { Clock, IdGen, MissedSleep, SyncClient, TimerOwner } from './types';

/**
 * Sleeps nobody announced, and the other ways a gap could be billed.
 *
 * Windows Modern Standby often freezes the process without a `suspend` event,
 * so the timer's own proof-of-life gap check is what has to close the entry.
 * Every scenario checks the two totals that must agree: the widget's
 * (status().workedMs) and the server's (its copy after sync).
 */

const T0 = Date.UTC(2026, 9, 10, 2, 0, 0); // 02:00 UTC: the day window holds every scenario
const SEC = 1_000;
const MIN = 60_000;
const OWNER: TimerOwner = { userId: 'user-1', workspaceId: 'w1' };

/**
 * Three clocks, as on a real machine. `t` is the timer's (server-aligned,
 * monotonic-driven) frame; `wall` the device clock; `mono` the raw monotonic.
 */
class DeviceClock implements Clock {
  t = T0;
  wall = T0 + 7 * SEC; // a device clock a few seconds off the server's
  mono = 5_000;
  now() { return this.t; }
  wallNow() { return this.wall; }
  monoNow() { return this.mono; }
  /** The process is running: every clock advances. */
  run(ms: number) {
    this.t += ms;
    this.wall += ms;
    this.mono += ms;
  }
  /** Windows Modern Standby: the process is frozen but the counters keep going. */
  freeze(ms: number) {
    this.run(ms);
  }
  /** macOS sleep: the monotonic source (and the timer frame on it) stands still. */
  sleepMac(ms: number) {
    this.wall += ms;
  }
}

class SeqIds implements IdGen {
  private n = 0;
  ulid() {
    this.n += 1;
    return `id_${String(this.n).padStart(6, '0')}`;
  }
}

/** The server's copy can carry a close only the server makes. */
type ServerRow = Omit<TimeEntry, 'closeReason'> & { closeReason: TimeEntryCloseReason | null };

/**
 * Just enough of the server: applies a newer revision, and answers an older
 * one with its own close when it closed the entry for silence (lease lapsed).
 */
class FakeServer implements SyncClient {
  online = true;
  rows = new Map<string, ServerRow>();
  pushes: TimeEntry[] = [];

  async create(entry: TimeEntry) { return this.apply(entry); }
  async sync(entry: TimeEntry) { return this.apply(entry); }

  /** The lease lapsed: close at the last instant the agent proved. */
  expireLease(entryId: string, lastProvenAt: number) {
    const row = this.rows.get(entryId)!;
    this.rows.set(entryId, {
      ...row,
      endedAt: lastProvenAt,
      closeReason: 'LEASE_EXPIRED',
      segments: row.segments.map((s) => ({ ...s, endedAt: s.endedAt ?? lastProvenAt })),
    });
  }

  workedMs(entryId: string, now: number) {
    return totalWorkedMs({ ...this.rows.get(entryId)!, closeReason: null }, now);
  }

  private apply(entry: TimeEntry): TimerSyncReceipt {
    if (!this.online) throw new Error('fetch failed');
    this.pushes.push(structuredClone(entry));
    const held = this.rows.get(entry.id);
    if (held && held.closeReason === 'LEASE_EXPIRED' && entry.revision <= held.revision) {
      return receipt(held, 'FINALIZED');
    }
    this.rows.set(entry.id, structuredClone(entry));
    return receipt(entry, 'APPLIED');
  }
}

function receipt(entry: ServerRow, disposition: TimerSyncReceipt['disposition']): TimerSyncReceipt {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    disposition,
    acceptedRevision: entry.revision,
    canonicalHash: createHash('sha256').update(canonicalTimerEntryPayload(entry)).digest('hex'),
    canonicalEntry: {
      id: entry.id,
      clientUuid: entry.clientUuid,
      userId: entry.userId,
      larkTaskGuid: entry.larkTaskGuid ?? null,
      source: entry.source,
      trackingProtocolVersion: 2,
      revision: entry.revision,
      lastProvenAt: iso(entry.endedAt ?? T0),
      leaseExpiresAt: null,
      closeReason: entry.closeReason,
      serverFinalizedAt: null,
      startedAt: iso(entry.startedAt)!,
      endedAt: iso(entry.endedAt),
      notes: null,
      segments: entry.segments.map((s) => ({ id: s.id, kind: s.kind, startedAt: iso(s.startedAt)!, endedAt: iso(s.endedAt) })),
    },
    serverTime: new Date(T0).toISOString(),
    correction: null,
  };
}

const allowAccrual = { assertCanAccrue: async () => undefined };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let db: Database.Database;
let clock: DeviceClock;
let server: FakeServer;
let store: SqliteEntryStore;
let svc: TimerService;
let missed: MissedSleep[];

function boot(): TimerService {
  const next = new TimerService(store, server, clock, new SeqIds(), allowAccrual);
  next.bindOwner(OWNER);
  next.setMissedSleepListener((m) => missed.push(m));
  return next;
}

/** The 1-second main loop, for `ms`. */
function tickFor(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += SEC) {
    clock.run(SEC);
    svc.noteAlive();
  }
}

function openEntryId(): string {
  const status = svc.status();
  if (status.state !== 'RUNNING') throw new Error('expected a running timer');
  return status.entryId;
}

function stored(entryId: string): TimeEntry {
  return store.listLedgerEntries(0).map((row) => row.entry).find((e) => e.id === entryId)!;
}

beforeEach(() => {
  db = new Database(':memory:');
  clock = new DeviceClock();
  server = new FakeServer();
  store = new SqliteEntryStore(db);
  missed = [];
  svc = boot();
});

describe('a sleep the OS never reported', () => {
  it('Windows-style (no suspend event, every clock jumps 90 min): closes at the last tick, and the widget and server agree', async () => {
    await svc.start({});
    const entryId = openEntryId();
    tickFor(10 * MIN);
    const lastTick = clock.t;
    await svc.flushUnsynced();
    await settle();
    // The server last heard from us a minute before the freeze, and its
    // lease lapsed while we were frozen.
    server.expireLease(entryId, lastTick - MIN);

    clock.freeze(90 * MIN);
    const result = svc.noteAlive();

    expect(result?.closed).toMatchObject({ entryId, closedAt: lastTick, wasAccruing: true });
    expect(missed).toHaveLength(1);
    expect(svc.isRunning()).toBe(false);
    expect(stored(entryId).endedAt).toBe(lastTick);
    expect(svc.status().workedMs).toBe(10 * MIN);
    expect(store.getLiveness()).toBeLessThanOrEqual(lastTick);

    await svc.flushUnsynced();
    await settle();
    await svc.flushUnsynced();
    await settle();

    // The server's silence close was answered with the truncated entry under
    // a newer revision — never one stretched across the 90 minutes.
    const onServer = server.rows.get(entryId)!;
    expect(onServer.closeReason).toBe('AGENT');
    expect(onServer.endedAt).toBe(lastTick);
    expect(server.workedMs(entryId, clock.t)).toBe(svc.status().workedMs);
    expect(server.pushes.every((p) => p.endedAt === null || p.endedAt <= lastTick)).toBe(true);
  });

  it('macOS-style (the monotonic clock stood still, only the wall clock jumped) is caught too', async () => {
    await svc.start({});
    const entryId = openEntryId();
    tickFor(5 * MIN);
    const lastTick = clock.t;

    clock.sleepMac(90 * MIN);
    clock.run(SEC);
    svc.noteAlive();

    expect(stored(entryId).endedAt).toBe(lastTick);
    expect(svc.status().workedMs).toBe(5 * MIN);
  });

  it('a resync answered after the sleep closes at the last tick instead of resending over it', async () => {
    await svc.start({});
    const entryId = openEntryId();
    const { revision } = svc.status() as { revision: number };
    tickFor(10 * MIN);
    const lastTick = clock.t;
    const provenAliveAt = svc.lastLiveness();
    // The heartbeat request went out, the machine slept, the answer landed
    // after the wake — before the main loop ran again.
    clock.freeze(90 * MIN);
    server.pushes = [];

    await svc.resyncFromServer(entryId, revision, { serverEndedAt: lastTick + 3 * MIN, provenAliveAt });
    await settle();

    expect(svc.isRunning()).toBe(false);
    expect(stored(entryId).endedAt).toBe(lastTick);
    expect(server.pushes.map((p) => p.endedAt)).toEqual([lastTick]);
  });

  it('brief standby wakes never bridge the sleep with proof of life', async () => {
    await svc.start({});
    const entryId = openEntryId();
    tickFor(10 * MIN);
    const lastTick = clock.t;

    // Modern Standby: frozen for 20 minutes, awake for 5 seconds, repeat.
    for (let i = 0; i < 4; i += 1) {
      clock.freeze(20 * MIN);
      tickFor(5 * SEC);
      svc.noteAlive({ persist: true }); // the heartbeat gets a beat in, too
    }

    expect(stored(entryId).endedAt).toBe(lastTick);
    expect(svc.status().workedMs).toBe(10 * MIN);
    expect(store.getLiveness()).toBeLessThanOrEqual(lastTick);
    // Only the first wake had anything to close.
    expect(missed.filter((m) => m.closed !== null)).toHaveLength(1);
  });

  it('ordinary stalls under the threshold are still worked time', async () => {
    await svc.start({});
    tickFor(MIN);
    clock.run(MISSED_SLEEP_GAP_MS - SEC); // a long GC pause / throttled timer
    svc.noteAlive();

    expect(svc.isRunning()).toBe(true);
    expect(missed).toEqual([]);
  });
});

describe('network down while the person keeps working', () => {
  it('keeps the 90 minutes and pushes them later under a newer revision', async () => {
    await svc.start({});
    const entryId = openEntryId();
    await settle();
    const created = server.rows.get(entryId)!;
    server.online = false;

    // 90 minutes of normal ticks; the heartbeat and the drain both fail.
    for (let minute = 0; minute < 90; minute += 1) {
      tickFor(MIN);
      svc.noteAlive({ persist: true });
      await svc.flushUnsynced();
      await settle();
    }
    expect(missed).toEqual([]);
    expect(svc.isRunning()).toBe(true);
    expect(svc.status().workedMs).toBe(90 * MIN);

    // Meanwhile the server closed it for silence at the last proof it had.
    server.expireLease(entryId, created.startedAt);
    server.online = true;
    // The first heartbeat back reports that close; we can prove we were alive.
    await svc.resyncFromServer(entryId, created.revision, {
      serverEndedAt: created.startedAt,
      provenAliveAt: svc.lastLiveness(),
    });
    await settle();
    await svc.flushUnsynced();
    await settle();

    const onServer = server.rows.get(entryId)!;
    expect(onServer.revision).toBeGreaterThan(created.revision);
    expect(onServer.endedAt).toBeNull();
    expect(server.workedMs(entryId, clock.t)).toBe(svc.status().workedMs);
  });
});

describe('a lock event delivered late, after the wake', () => {
  it('closes at the last tick, not at the moment the event arrived', async () => {
    await svc.start({});
    const entryId = openEntryId();
    tickFor(10 * MIN);
    const lastTick = clock.t;

    clock.freeze(90 * MIN);
    // The lock lands before the main loop has run again.
    await svc.prepareForAway('lock', 0);

    expect(stored(entryId).endedAt).toBe(lastTick);
    expect(svc.status().workedMs).toBe(10 * MIN);
    // The main loop then finds the gap with nothing left to close.
    clock.run(SEC);
    expect(svc.noteAlive()).toMatchObject({ closed: null });
  });

  it('an on-time lock still closes where the person left (idle backdating)', async () => {
    await svc.start({});
    const entryId = openEntryId();
    tickFor(10 * MIN);

    await svc.prepareForAway('lock', 2 * MIN);

    expect(stored(entryId).endedAt).toBe(clock.t - 2 * MIN);
  });
});

describe('crash recovery never over-credits', () => {
  it('a crash before the first tick recovers at the start, not at reboot', async () => {
    await svc.start({});
    const entryId = openEntryId();
    clock.run(2 * 60 * MIN); // the process died, the machine stayed off

    svc = boot();
    const result = svc.recoverAtLastProofOfLife();

    expect(result?.entryId).toBe(entryId);
    expect(stored(entryId).endedAt).toBe(T0);
    expect(totalWorkedMs(stored(entryId))).toBe(0);
  });

  it('a crash right after a resume recovers at the resume, not at the tick before the pause', async () => {
    await svc.start({});
    const entryId = openEntryId();
    tickFor(5 * MIN);
    await svc.pause();
    clock.run(30 * MIN);
    await svc.resume();
    const resumedAt = clock.t;
    clock.run(3 * 60 * MIN);

    svc = boot();
    svc.recoverAtLastProofOfLife();

    expect(stored(entryId).endedAt).toBe(resumedAt);
    expect(totalWorkedMs(stored(entryId))).toBe(5 * MIN);
  });

  it('a quit that died mid-close recovers at the quit, the last proof it gave', async () => {
    await svc.start({});
    const entryId = openEntryId();
    tickFor(MIN);
    clock.run(10 * SEC);
    store.setExitIntent({ reason: 'shutdown', entryId, observedAt: clock.t });
    const quitAt = clock.t;
    clock.run(60 * MIN);

    svc = boot();
    svc.recoverAtLastProofOfLife();

    expect(stored(entryId).endedAt).toBe(quitAt);
    expect(store.getExitIntent()).toBeNull();
  });
});
