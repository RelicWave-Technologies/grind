import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalTimerEntryPayload, closeTimeEntry, createTimeEntry, type TimeEntry } from '@grind/core';
import type { TimerSyncReceipt } from '@grind/types';
import { ApiNetworkError } from '../network';
import { HttpError, retryAfterMs } from '../apiClient';
import { SqliteEntryStore } from './sqliteStore';
import { TimerService } from './timerService';
import { classifySyncFailure, PARK_AFTER_ATTEMPTS, PARKED_RETRY_MS, rowRetryAt, SyncPause } from './syncPolicy';
import type { Clock, IdGen, SyncClient, TimerOwner } from './types';

const T0 = Date.UTC(2026, 9, 10, 2, 0, 0);
const SEC = 1_000;
const MIN = 60_000;
const OWNER: TimerOwner = { userId: 'user-1', workspaceId: 'w1' };

describe('classifySyncFailure', () => {
  it('blames the server for no response, 5xx, 429, 408 and a lost session', () => {
    expect(classifySyncFailure(new ApiNetworkError('/x', new TypeError('fetch failed')))).toMatchObject({ scope: 'server', noResponse: true });
    expect(classifySyncFailure(new HttpError('/x', 503, ''))).toMatchObject({ scope: 'server', noResponse: false });
    expect(classifySyncFailure(new HttpError('/x', 429, '', 90_000))).toMatchObject({ scope: 'server', retryAfterMs: 90_000 });
    expect(classifySyncFailure(new HttpError('/x', 408, ''))).toMatchObject({ scope: 'server' });
  });

  it('blames the row for any other refusal', () => {
    expect(classifySyncFailure(new HttpError('/x', 409, '{"error":"timer_conflict"}'))).toEqual({
      scope: 'row',
      error: 'http_409:timer_conflict',
    });
    expect(classifySyncFailure(new HttpError('/x', 400, ''))).toMatchObject({ scope: 'row' });
  });
});

describe('retryAfterMs', () => {
  const res = (value: string | null) => ({ headers: new Headers(value === null ? {} : { 'retry-after': value }) });
  it('reads delta-seconds and HTTP dates, and ignores junk', () => {
    expect(retryAfterMs(res('120'))).toBe(120_000);
    expect(retryAfterMs(res(new Date(T0 + 90_000).toUTCString()), T0)).toBe(90_000);
    expect(retryAfterMs(res('soon'))).toBeNull();
    expect(retryAfterMs(res(null))).toBeNull();
  });
});

describe('row backoff', () => {
  it('backs off, then parks a row the server keeps refusing for a day', () => {
    expect(rowRetryAt(0, 1)).toBe(30 * SEC);
    expect(rowRetryAt(0, PARK_AFTER_ATTEMPTS - 1)).toBe(4 * MIN);
    expect(rowRetryAt(0, PARK_AFTER_ATTEMPTS)).toBe(PARKED_RETRY_MS);
  });
});

describe('SyncPause', () => {
  it('waits at least as long as the server asked', () => {
    const pause = new SyncPause();
    pause.note({ scope: 'server', error: 'http_429', retryAfterMs: 10 * MIN, noResponse: false }, 0);
    expect(pause.isPaused(10 * MIN - 1)).toBe(true);
    expect(pause.isPaused(10 * MIN)).toBe(false);
  });

  it('lifts a no-response pause as soon as another request gets an answer, but not a server-requested one', () => {
    const pause = new SyncPause();
    pause.note({ scope: 'server', error: 'http_503', retryAfterMs: null, noResponse: false }, 0);
    pause.noteReachable();
    expect(pause.isPaused(1)).toBe(true);

    pause.note({ scope: 'server', error: 'offline', retryAfterMs: null, noResponse: true }, 0);
    pause.noteReachable();
    expect(pause.isPaused(1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

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

function receipt(entry: TimeEntry, overrides: Partial<TimerSyncReceipt> = {}): TimerSyncReceipt {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    disposition: 'APPLIED',
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
    ...overrides,
  };
}

/** A server whose answer the test scripts per push. */
class ScriptedServer implements SyncClient {
  pushes: string[] = [];
  answer: (entry: TimeEntry) => TimerSyncReceipt = (entry) => receipt(entry);
  async create(entry: TimeEntry) { return this.push(entry); }
  async sync(entry: TimeEntry) { return this.push(entry); }
  private push(entry: TimeEntry) {
    this.pushes.push(entry.id);
    return this.answer(entry);
  }
}

let clock: FakeClock;
let store: SqliteEntryStore;
let server: ScriptedServer;
let svc: TimerService;

function closedEntry(id: string, startedAt: number): TimeEntry {
  const open = createTimeEntry({ id, clientUuid: `c_${id}`, userId: OWNER.userId, source: 'AUTO', startedAt, segmentId: `s_${id}` });
  return closeTimeEntry(open, startedAt + 10 * MIN);
}

beforeEach(() => {
  clock = new FakeClock();
  store = new SqliteEntryStore(new Database(':memory:'));
  server = new ScriptedServer();
  svc = new TimerService(store, server, clock, new SeqIds(), { assertCanAccrue: async () => undefined });
  svc.bindOwner(OWNER);
});

describe('TimerService drain under the sync policy', () => {
  it('stops a pass at the first 5xx instead of trying every row, and honours Retry-After', async () => {
    for (let i = 0; i < 10; i += 1) store.upsert(closedEntry(`e${i}`, T0 - (20 - i) * MIN));
    server.answer = () => { throw new HttpError('/v1/time-entries', 503, '', 5 * MIN); };

    expect(await svc.flushUnsynced()).toBe(false);
    expect(server.pushes).toEqual(['e0']);
    // The row was not at fault: it keeps no error count of its own.
    expect(store.getUnsynced(clock.t).map((r) => r.attempts)).toEqual(Array(10).fill(0));

    clock.t += 4 * MIN; // inside Retry-After (longer than the 30s backoff)
    await svc.flushUnsynced();
    expect(server.pushes).toHaveLength(1);

    server.answer = (entry) => receipt(entry);
    clock.t += MIN;
    await svc.flushUnsynced();
    expect(store.getUnsynced(clock.t)).toEqual([]);
  });

  it('acknowledges an APPLIED receipt for its revision even when the server normalised the payload', async () => {
    const entry = closedEntry('e1', T0 - 20 * MIN);
    store.upsert(entry);
    server.answer = (pushed) => receipt(pushed, { canonicalHash: 'f'.repeat(64) });

    await svc.flushUnsynced();
    clock.t += 30 * MIN;
    await svc.flushUnsynced();

    expect(server.pushes).toEqual(['e1']);
    expect(store.getUnsynced(clock.t)).toEqual([]);
  });

  it('never resends a refused row at high frequency, parks it, and reports it parked', async () => {
    store.upsert(closedEntry('stuck', T0 - 20 * MIN));
    server.answer = () => { throw new HttpError('/v1/time-entries/stuck/sync', 409, '{"error":"revision_payload_conflict"}'); };

    // A drain every 12 seconds for an hour — the beta.37 storm's cadence.
    for (let t = 0; t < 60 * MIN; t += 12 * SEC) {
      clock.t += 12 * SEC;
      await svc.flushUnsynced();
    }

    expect(server.pushes).toHaveLength(PARK_AFTER_ATTEMPTS);
    expect(svc.syncBacklog()).toMatchObject({ pending: 1, parked: 1, lastError: 'http_409:revision_payload_conflict' });
  });

  it('a server that keeps finalizing a resend is answered once per backoff step, not every pass', async () => {
    const entry = closedEntry('e1', T0 - 20 * MIN);
    store.upsert(entry);
    server.answer = (pushed) => {
      const finalized = receipt({ ...pushed, revision: pushed.revision + 1 }, { disposition: 'FINALIZED', correction: 'LEASE_FINALIZED' });
      finalized.canonicalEntry.closeReason = 'LEASE_EXPIRED';
      finalized.acceptedRevision = pushed.revision;
      return finalized;
    };

    for (let t = 0; t < 5 * MIN; t += 12 * SEC) {
      clock.t += 12 * SEC;
      await svc.flushUnsynced();
    }

    expect(server.pushes.length).toBeLessThanOrEqual(10);
  });
});
