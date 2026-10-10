import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalTimerEntryPayload, totalWorkedMs, type TimeEntry } from '@grind/core';
import type { TimerSyncReceipt } from '@grind/types';
import { SqliteEntryStore } from './sqliteStore';
import { TimerService, UNTAGGED_LIVENESS_REACH_MS } from './timerService';
import type { Clock, IdGen, SyncClient, TimerOwner } from './types';

/**
 * A row left open long ago must close at its OWN last boundary — never at a
 * proof of life written while some other entry was running.
 *
 * Field case (beta.38): a row opened 2026-08-10 stayed open on disk, invisible,
 * until beta.38 surfaced it; boot recovery closed it at that day's liveness
 * tick (2026-10-10 15:43), uploading a 61-day entry that showed as "worked
 * since midnight" on the Today screen.
 */

const T0 = Date.UTC(2026, 9, 10, 10, 0, 0); // 15:30 IST on the field day
const SEC = 1_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const OWNER: TimerOwner = { userId: 'user-1', workspaceId: 'w1' };

class FakeClock implements Clock {
  t = T0;
  now() { return this.t; }
  wallNow() { return this.t; }
  monoNow() { return this.t; }
}

class SeqIds implements IdGen {
  private n = 0;
  ulid() {
    this.n += 1;
    return `id_${String(this.n).padStart(6, '0')}`;
  }
}

class FakeServer implements SyncClient {
  rows = new Map<string, TimeEntry>();
  async create(entry: TimeEntry) { return this.apply(entry); }
  async sync(entry: TimeEntry) { return this.apply(entry); }
  private apply(entry: TimeEntry): TimerSyncReceipt {
    this.rows.set(entry.id, structuredClone(entry));
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
    };
  }
}

const allowAccrual = { assertCanAccrue: async () => undefined };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let db: Database.Database;
let clock: FakeClock;
let server: FakeServer;
let store: SqliteEntryStore;

/** A fresh process: no owner bound yet, exactly as initTimerOnBoot finds it. */
function freshService(): TimerService {
  return new TimerService(store, server, clock, new SeqIds(), allowAccrual);
}

/** An open row as an older run left it: last segment WORK, still open. */
function openRow(id: string, startedAt: number, lastSegmentStartedAt: number, userId = OWNER.userId): TimeEntry {
  const segments: TimeEntry['segments'] = [{ id: `${id}-s1`, kind: 'WORK', startedAt, endedAt: null }];
  if (lastSegmentStartedAt !== startedAt) {
    segments[0] = { ...segments[0]!, endedAt: startedAt + 30 * MIN };
    segments.push({ id: `${id}-s2`, kind: 'WORK', startedAt: lastSegmentStartedAt, endedAt: null });
  }
  return {
    id,
    clientUuid: `${id}-uuid`,
    userId,
    larkTaskGuid: 'daily-working',
    source: 'AUTO',
    revision: 1,
    startedAt,
    endedAt: null,
    pauseReason: null,
    closeReason: null,
    segments,
  };
}

/** A new process on the same database: a fresh store, bound at boot. */
function reboot(): TimerService {
  store = new SqliteEntryStore(db);
  const svc = freshService();
  svc.switchOwner(OWNER, true);
  return svc;
}

function stored(id: string): TimeEntry {
  const row = db.prepare(`SELECT json FROM local_entries WHERE id = ?`).get(id) as { json: string };
  return JSON.parse(row.json) as TimeEntry;
}

/** A liveness tick as beta.38 and older wrote it: a bare timestamp, no entry. */
function writeUntaggedLiveness(at: number) {
  db.prepare(`INSERT INTO timer_meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(`${OWNER.workspaceId}:${OWNER.userId}:liveness`, String(at));
  db.prepare(`DELETE FROM timer_meta WHERE key = ?`).run(`${OWNER.workspaceId}:${OWNER.userId}:liveness_entry`);
}

const STALE_START = T0 - 61 * DAY;
const STALE_LAST_SEGMENT = STALE_START + 3 * 60 * MIN;

beforeEach(() => {
  db = new Database(':memory:');
  clock = new FakeClock();
  server = new FakeServer();
  store = new SqliteEntryStore(db);
});

describe('a stale open row is closed at its own last boundary', () => {
  it('60-day-old open row + a fresh liveness tick written for another entry: closed at its own last segment start', async () => {
    store.bindOwner(OWNER);
    store.upsert(openRow('stale', STALE_START, STALE_LAST_SEGMENT));
    store.setLiveness(T0 - 2 * MIN, 'todays-entry');
    store.bindOwner(null);

    const svc = freshService();
    const recovered = svc.switchOwner(OWNER, true);

    expect(recovered.map((r) => r.entryId)).toEqual(['stale']);
    const closed = stored('stale');
    expect(closed.endedAt).toBe(STALE_LAST_SEGMENT);
    expect(closed.closeReason).toBe('AGENT_RECOVERY');
    expect(closed.segments.every((s) => s.endedAt !== null && s.endedAt <= STALE_LAST_SEGMENT)).toBe(true);
    expect(totalWorkedMs(closed)).toBe(30 * MIN); // only what it had already closed

    // Nothing of it reaches today, locally or on the server.
    expect(svc.status().workedMs).toBe(0);
    await svc.flushUnsynced();
    expect(server.rows.get('stale')?.endedAt).toBe(STALE_LAST_SEGMENT);
  });

  it('a pre-beta.39 (untagged) tick far past the row is not its proof', () => {
    store.bindOwner(OWNER);
    store.upsert(openRow('stale', STALE_START, STALE_LAST_SEGMENT));
    writeUntaggedLiveness(T0 - 2 * MIN);
    store.bindOwner(null);

    freshService().switchOwner(OWNER, true);

    expect(stored('stale').endedAt).toBe(STALE_LAST_SEGMENT);
  });

  it('a pre-beta.39 (untagged) tick still recovers the row that was really running', () => {
    store.bindOwner(OWNER);
    store.upsert(openRow('running', T0 - 60 * MIN, T0 - 60 * MIN));
    writeUntaggedLiveness(T0 - 2 * MIN);
    store.bindOwner(null);

    freshService().switchOwner(OWNER, true);

    expect(stored('running').endedAt).toBe(T0 - 2 * MIN);
  });

  it('an untagged tick just beyond the reach is ignored, just within it is honoured', () => {
    store.bindOwner(OWNER);
    const start = T0 - UNTAGGED_LIVENESS_REACH_MS - 10 * MIN;
    store.upsert(openRow('long', start, start));
    writeUntaggedLiveness(start + UNTAGGED_LIVENESS_REACH_MS + MIN);
    store.bindOwner(null);
    freshService().switchOwner(OWNER, true);
    expect(stored('long').endedAt).toBe(start);

    db.prepare(`DELETE FROM local_entries`).run();
    store.bindOwner(OWNER);
    store.upsert(openRow('within', start, start));
    writeUntaggedLiveness(start + UNTAGGED_LIVENESS_REACH_MS - MIN);
    store.bindOwner(null);
    freshService().switchOwner(OWNER, true);
    expect(stored('within').endedAt).toBe(start + UNTAGGED_LIVENESS_REACH_MS - MIN);
  });

  it('the tick of the entry that was running still recovers that entry', async () => {
    const svc = freshService();
    svc.switchOwner(OWNER, true);
    const started = await svc.start({ larkTaskGuid: 'daily-working' });
    if (started.state !== 'RUNNING') throw new Error('expected running');
    for (let i = 0; i < 60; i += 1) {
      clock.t += SEC;
      svc.noteAlive();
    }
    const lastTick = store.getLiveness()!;
    expect(store.getLivenessEntryId()).toBe(started.entryId);
    clock.t += 3 * 60 * MIN; // crashed; machine off

    reboot();

    expect(stored(started.entryId).endedAt).toBe(lastTick);
  });

  it('two open rows: the old stray ends at its own boundary, the running one at its tick', async () => {
    store.bindOwner(OWNER);
    store.upsert(openRow('stale', STALE_START, STALE_LAST_SEGMENT));
    store.bindOwner(null);
    const svc = freshService();
    // Quarantine the stale row from the first boot, as beta.37 effectively did.
    db.prepare(`UPDATE local_entries SET owner_user_id = 'other' WHERE id = 'stale'`).run();
    svc.switchOwner(OWNER, true);
    const started = await svc.start({});
    if (started.state !== 'RUNNING') throw new Error('expected running');
    clock.t += 5 * MIN;
    svc.noteAlive({ persist: true });
    const tick = clock.t;
    db.prepare(`UPDATE local_entries SET owner_user_id = ? WHERE id = 'stale'`).run(OWNER.userId);
    clock.t += 60 * MIN;

    reboot();

    expect(stored('stale').endedAt).toBe(STALE_LAST_SEGMENT);
    expect(stored(started.entryId).endedAt).toBe(tick);
  });
});

describe('legacy "self" rows claimed after recovery', () => {
  it('an open legacy row is closed at its own boundary, not left open to count from midnight', () => {
    store.bindOwner(OWNER);
    // An owned row so this machine has had only this account.
    store.upsert({ ...openRow('mine', T0 - 3 * DAY, T0 - 3 * DAY), endedAt: T0 - 3 * DAY + 10 * MIN, segments: [{ id: 'mine-s1', kind: 'WORK', startedAt: T0 - 3 * DAY, endedAt: T0 - 3 * DAY + 10 * MIN }] });
    store.setLiveness(T0 - MIN, 'mine');
    store.bindOwner(null);
    const legacy = openRow('legacy', STALE_START, STALE_LAST_SEGMENT, 'self');
    db.prepare(
      `INSERT INTO local_entries (id, client_uuid, ended_at, sync_state, owner_user_id, owner_workspace_id, json)
       VALUES (?, ?, NULL, 'synced', NULL, NULL, ?)`,
    ).run(legacy.id, legacy.clientUuid, JSON.stringify(legacy));

    const svc = freshService();
    svc.switchOwner(OWNER, true);
    const result = svc.claimLegacySelfEntries();

    expect(result.claimed).toBe(1);
    expect(store.listOpen()).toEqual([]);
    const closed = stored('legacy');
    expect(closed.endedAt).toBe(STALE_LAST_SEGMENT);
    expect(closed.userId).toBe(OWNER.userId);
    expect(svc.status().workedMs).toBe(0);
  });

  it('claiming never closes the entry this process is running', async () => {
    store.bindOwner(OWNER);
    store.upsert({ ...openRow('mine', T0 - 3 * DAY, T0 - 3 * DAY), endedAt: T0 - 3 * DAY + 10 * MIN, segments: [{ id: 'mine-s1', kind: 'WORK', startedAt: T0 - 3 * DAY, endedAt: T0 - 3 * DAY + 10 * MIN }] });
    store.bindOwner(null);
    const svc = freshService();
    svc.switchOwner(OWNER, true);
    const started = await svc.start({});
    if (started.state !== 'RUNNING') throw new Error('expected running');
    const legacy = openRow('legacy', STALE_START, STALE_LAST_SEGMENT, 'self');
    db.prepare(
      `INSERT INTO local_entries (id, client_uuid, ended_at, sync_state, owner_user_id, owner_workspace_id, json)
       VALUES (?, ?, NULL, 'synced', NULL, NULL, ?)`,
    ).run(legacy.id, legacy.clientUuid, JSON.stringify(legacy));

    svc.claimLegacySelfEntries();

    expect(stored('legacy').endedAt).toBe(STALE_LAST_SEGMENT);
    expect(stored(started.entryId).endedAt).toBeNull();
    expect(svc.isRunning()).toBe(true);
  });
});

describe('server-requested recovery closes the entry it validated', () => {
  it('a newer open row on disk is not closed in place of the live entry', async () => {
    const svc = freshService();
    svc.switchOwner(OWNER, true);
    const started = await svc.start({});
    if (started.state !== 'RUNNING') throw new Error('expected running');
    await settle();
    clock.t += MIN;
    svc.noteAlive({ persist: true });
    const provenAliveAt = clock.t;
    // A stray open row that sorts newest on disk.
    store.upsert(openRow('stray', STALE_START, STALE_LAST_SEGMENT));
    clock.t += 5 * SEC;

    await svc.resyncFromServer(started.entryId, started.revision, {
      serverEndedAt: provenAliveAt + 30 * SEC,
      provenAliveAt,
    });

    expect(stored(started.entryId).endedAt).toBe(provenAliveAt);
    expect(stored('stray').endedAt).toBeNull();
  });
});
