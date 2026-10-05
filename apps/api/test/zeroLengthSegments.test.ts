import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { reconcileExpiredTimersOnce } from '../src/timeLifecycle';
import { fakeUlid, iso, seedUser } from './helpers';

/**
 * ZERO-LENGTH SEGMENTS (packages/core/src/segments.ts): accepted, dropped
 * before anything is stored, never a 400 and never a clock correction. Agents
 * up to beta.38 send them whenever a pause lands on a segment's start; newer
 * agents remove the segment instead, which can leave an entry with none.
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const MIN = 60_000;

type Seg = { id: string; kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED'; startedAt: string; endedAt: string | null };

function seg(startMs: number, endMs: number | null, kind: Seg['kind'] = 'WORK'): Seg {
  return { id: fakeUlid('zseg'), kind, startedAt: iso(startMs), endedAt: endMs === null ? null : iso(endMs) };
}

function v2Create(startMs: number, endMs: number | null, segments: Seg[], revision = 1) {
  return {
    id: fakeUlid('zentry'),
    clientUuid: fakeUlid('zclient'),
    source: 'AUTO',
    trackingProtocolVersion: 2,
    revision,
    observedAt: iso(endMs ?? startMs),
    startedAt: iso(startMs),
    endedAt: endMs === null ? null : iso(endMs),
    closeReason: endMs === null ? null : 'AGENT',
    agentVersion: '0.0.2-beta.37',
    platform: 'darwin',
    segments,
  };
}

function v2Sync(revision: number, endMs: number | null, segments: Seg[], observedMs: number) {
  return {
    trackingProtocolVersion: 2,
    revision,
    observedAt: iso(observedMs),
    endedAt: endMs === null ? null : iso(endMs),
    closeReason: endMs === null ? null : 'AGENT',
    segments,
  };
}

describe('zero-length segments from older agents', () => {
  it('drops one inside a closed entry: 201, no clock correction, and an identical retry settles as STALE', async () => {
    const user = await seedUser();
    const start = Date.now() - 30 * MIN;
    const zero = seg(start, start);
    const work = seg(start, start + 20 * MIN);
    const body = v2Create(start, start + 20 * MIN, [zero, work]);

    const first = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ disposition: 'APPLIED', correction: null, acceptedRevision: 1 });
    expect(first.body.canonicalEntry.segments.map((s: Seg) => s.id)).toEqual([work.id]);

    const stored = await prisma.timeSegment.findMany({ where: { timeEntryId: body.id } });
    expect(stored.map((s) => s.id)).toEqual([work.id]);

    // An old agent hashes its own copy (with the empty span), so the first
    // receipt does not match it; its retry of the same revision must settle.
    const retry = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ disposition: 'STALE', acceptedRevision: 1, canonicalHash: first.body.canonicalHash });
  });

  it('keeps an entry whose only segment was zero-length, closed at its start with no segments', async () => {
    const user = await seedUser();
    const start = Date.now() - 10 * MIN;
    const body = v2Create(start, start, [seg(start, start)]);

    const res = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ disposition: 'APPLIED', correction: null });
    expect(res.body.canonicalEntry).toMatchObject({ startedAt: iso(start), endedAt: iso(start), segments: [] });
    const row = await prisma.timeEntry.findUniqueOrThrow({ where: { id: body.id }, include: { segments: true } });
    expect(row.segments).toEqual([]);
    expect(row.endedAt?.getTime()).toBe(start);
  });

  it('accepts a legacy (pre-v2) create with a zero-length segment', async () => {
    const user = await seedUser();
    const start = Date.now() - 10 * MIN;
    const { trackingProtocolVersion: _v, revision: _r, observedAt: _o, closeReason: _c, ...legacy } =
      v2Create(start, start + 5 * MIN, [seg(start, start), seg(start, start + 5 * MIN)]);

    const res = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(legacy);

    expect(res.status).toBe(201);
    expect(res.body.segments).toHaveLength(1);
  });

  it('follows a paused-at-start entry through resume and stop, bumping revisions, never a 400', async () => {
    const user = await seedUser();
    const start = Date.now() - 30 * MIN;
    // Paused the instant it started: beta.37 keeps the empty span.
    const zero = seg(start, start);
    const body = v2Create(start, null, [zero]);
    const created = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    expect(created.status).toBe(201);
    expect(created.body.canonicalEntry).toMatchObject({ endedAt: null, segments: [] });

    // Resumed five minutes later.
    const resumed = seg(start + 5 * MIN, null);
    const r2 = await request(app)
      .put(`/v1/time-entries/${body.id}/sync`)
      .set(bearer(user.accessToken))
      .send(v2Sync(2, null, [zero, resumed], start + 6 * MIN));
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ disposition: 'APPLIED', acceptedRevision: 2, correction: null });
    expect(r2.body.canonicalEntry.segments.map((s: Seg) => s.id)).toEqual([resumed.id]);

    // Stopped.
    const closedWork = { ...resumed, endedAt: iso(start + 20 * MIN) };
    const r3 = await request(app)
      .put(`/v1/time-entries/${body.id}/sync`)
      .set(bearer(user.accessToken))
      .send(v2Sync(3, start + 20 * MIN, [zero, closedWork], start + 20 * MIN));
    expect(r3.status).toBe(200);
    expect(r3.body).toMatchObject({ disposition: 'APPLIED', acceptedRevision: 3, correction: null });
    expect(r3.body.canonicalEntry).toMatchObject({ endedAt: iso(start + 20 * MIN), startedAt: iso(start) });

    // The old agent retries revision 3 once (its hash still includes the empty span).
    const retry = await request(app)
      .put(`/v1/time-entries/${body.id}/sync`)
      .set(bearer(user.accessToken))
      .send(v2Sync(3, start + 20 * MIN, [zero, closedWork], start + 20 * MIN));
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ disposition: 'STALE', acceptedRevision: 3, canonicalHash: r3.body.canonicalHash });
  });
});

describe('entries without segments from newer agents', () => {
  it('accepts an open entry with no segments (paused on its first instant) and a later resume', async () => {
    const user = await seedUser();
    const start = Date.now() - 20 * MIN;
    const body = v2Create(start, null, []);
    const created = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    expect(created.status).toBe(201);
    expect(created.body.canonicalEntry).toMatchObject({ endedAt: null, segments: [] });

    // The first remaining segment starts after the entry: valid, not a 400.
    const resumed = seg(start + 3 * MIN, null);
    const synced = await request(app)
      .put(`/v1/time-entries/${body.id}/sync`)
      .set(bearer(user.accessToken))
      .send(v2Sync(2, null, [resumed], start + 4 * MIN));
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ disposition: 'APPLIED', acceptedRevision: 2 });

    // And a close that leaves nothing (start→stop in one instant) is accepted too.
    const emptied = await request(app)
      .put(`/v1/time-entries/${body.id}/sync`)
      .set(bearer(user.accessToken))
      .send(v2Sync(3, start + 3 * MIN, [], start + 3 * MIN));
    expect(emptied.status).toBe(200);
    expect(emptied.body.canonicalEntry).toMatchObject({ endedAt: iso(start + 3 * MIN), segments: [] });
  });

  it('still rejects a segment that starts before its entry', async () => {
    const user = await seedUser();
    const start = Date.now() - 20 * MIN;
    const body = v2Create(start, null, [seg(start, null)]);
    expect((await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body)).status).toBe(201);

    const res = await request(app)
      .put(`/v1/time-entries/${body.id}/sync`)
      .set(bearer(user.accessToken))
      .send(v2Sync(2, null, [seg(start - MIN, null)], start));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_segments');
  });

  it('still rejects an inverted segment', async () => {
    const user = await seedUser();
    const start = Date.now() - 20 * MIN;
    const body = v2Create(start, start + 5 * MIN, [seg(start, start + 5 * MIN), { ...seg(start + 6 * MIN, start + 5 * MIN) }]);
    const res = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_segments');
  });
});

describe('CLOCK_CLAMP means a real clock clamp', () => {
  it('is set when a timestamp is beyond server now + skew, even alongside a dropped segment', async () => {
    const user = await seedUser();
    const start = Date.now() - 5 * MIN;
    const future = Date.now() + 60 * MIN;
    const body = v2Create(start, future, [seg(start, start), seg(start, future)]);

    const res = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);

    expect(res.status).toBe(201);
    expect(res.body.correction).toBe('CLOCK_CLAMP');
    expect(new Date(res.body.canonicalEntry.endedAt).getTime()).toBeLessThan(future);
    expect(res.body.canonicalEntry.segments).toHaveLength(1);
  });

  it('is not set for an entry that only lost a zero-length segment', async () => {
    const user = await seedUser();
    const start = Date.now() - 5 * MIN;
    const body = v2Create(start, start + 2 * MIN, [seg(start, start + 2 * MIN), seg(start + 2 * MIN, start + 2 * MIN)]);
    const res = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.correction).toBeNull();
  });
});

describe('lease finalization', () => {
  it('removes an open segment that would close at its own start instead of storing it empty', async () => {
    const user = await seedUser();
    const start = Date.now() - 30 * MIN;
    const first = seg(start, start + 5 * MIN);
    const resumed = seg(start + 10 * MIN, null);
    const body = v2Create(start, null, [first, resumed]);
    expect((await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body)).status).toBe(201);
    // Last proof of life was before the resumed segment began.
    await prisma.timeEntry.update({
      where: { id: body.id },
      data: { lastProvenAt: new Date(start + 6 * MIN), leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await reconcileExpiredTimersOnce()).toBeGreaterThanOrEqual(1);

    const row = await prisma.timeEntry.findUniqueOrThrow({ where: { id: body.id }, include: { segments: true } });
    expect(row.endedAt?.getTime()).toBe(start + 10 * MIN);
    expect(row.segments.map((s) => s.id)).toEqual([first.id]);
  });
});
