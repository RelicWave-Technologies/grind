import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildApp } from '../src/app';
import { seedUser, fakeUlid, iso, type SeededUser } from './helpers';

let app: Express;
beforeAll(() => {
  app = buildApp();
});

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function auth(req: request.Test, token: string) {
  return req.set('Authorization', `Bearer ${token}`);
}

function createBody(
  _u: SeededUser,
  over: { startedAtMs?: number; endedAtMs?: number | null; larkTaskGuid?: string | null; segments?: unknown[] } = {},
) {
  const startMs = over.startedAtMs ?? T0;
  return {
    id: fakeUlid('te'),
    clientUuid: fakeUlid('cu'),
    ...(over.larkTaskGuid !== undefined ? { larkTaskGuid: over.larkTaskGuid } : {}),
    source: 'AUTO',
    startedAt: iso(startMs),
    ...(over.endedAtMs !== undefined ? { endedAt: over.endedAtMs === null ? null : iso(over.endedAtMs) } : {}),
    agentVersion: '0.0.1',
    platform: 'darwin',
    // Default segment tracks the entry start so the invariant holds.
    segments: over.segments ?? [{ id: fakeUlid('seg'), kind: 'WORK', startedAt: iso(startMs), endedAt: null }],
  };
}

describe('auth gating', () => {
  it('401 without a token', async () => {
    const res = await request(app).get('/v1/time-entries');
    expect(res.status).toBe(401);
  });

  it('401 with a garbage token', async () => {
    const res = await auth(request(app).get('/v1/time-entries'), 'not-a-jwt');
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/time-entries', () => {
  it('creates an entry with an open WORK segment', async () => {
    const u = await seedUser();
    const body = createBody(u);
    const res = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(body.id);
    expect(res.body.userId).toBe(u.userId);
    expect(res.body.endedAt).toBeNull();
    expect(res.body.segments).toHaveLength(1);
    expect(res.body.segments[0]).toMatchObject({ kind: 'WORK', endedAt: null });
  });

  it('is idempotent on clientUuid (second POST returns 200, same entry)', async () => {
    const u = await seedUser();
    const body = createBody(u);
    const first = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    expect(first.status).toBe(201);
    // Re-send identical body (agent retry after a flaky network).
    const second = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('creates a closed entry from an offline snapshot', async () => {
    const u = await seedUser();
    const endedAtMs = T0 + 10 * MIN;
    const body = createBody(u, {
      endedAtMs,
      segments: [{ id: fakeUlid('seg'), kind: 'WORK', startedAt: iso(T0), endedAt: iso(endedAtMs) }],
    });

    const res = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);

    expect(res.status).toBe(201);
    expect(res.body.endedAt).toBe(iso(endedAtMs));
    expect(res.body.segments).toHaveLength(1);
    expect(res.body.segments[0]).toMatchObject({ kind: 'WORK', endedAt: iso(endedAtMs) });
  });

  it('rejects invalid segments (overlap)', async () => {
    const u = await seedUser();
    const body = createBody(u, {
      segments: [
        { id: fakeUlid('s'), kind: 'WORK', startedAt: iso(T0), endedAt: iso(T0 + 10 * MIN) },
        { id: fakeUlid('s'), kind: 'WORK', startedAt: iso(T0 + 5 * MIN), endedAt: null }, // overlaps
      ],
    });
    const res = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_segments');
    expect(String(res.body.details)).toMatch(/overlap/);
  });

  it('attributes an entry to a Lark task via larkTaskGuid', async () => {
    const u = await seedUser();
    const body = createBody(u, { larkTaskGuid: 'guid-xyz' });
    const res = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    expect(res.status).toBe(201);
    expect(res.body.larkTaskGuid).toBe('guid-xyz');
  });

  it('rejects a body that fails zod validation (missing segments)', async () => {
    const u = await seedUser();
    const body = createBody(u);
    delete (body as Record<string, unknown>).segments;
    const res = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });
});

describe('PUT /v1/time-entries/:id/sync', () => {
  it('replaces segments and closes the entry', async () => {
    const u = await seedUser();
    const body = createBody(u);
    await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);

    const segWorkId = fakeUlid('s');
    const segMeetId = fakeUlid('s');
    const sync = {
      endedAt: iso(T0 + 25 * MIN),
      segments: [
        { id: segWorkId, kind: 'WORK', startedAt: iso(T0), endedAt: iso(T0 + 10 * MIN) },
        { id: segMeetId, kind: 'MEETING', startedAt: iso(T0 + 10 * MIN), endedAt: iso(T0 + 25 * MIN) },
      ],
    };
    const res = await auth(request(app).put(`/v1/time-entries/${body.id}/sync`), u.accessToken).send(sync);
    expect(res.status).toBe(200);
    expect(res.body.endedAt).toBe(iso(T0 + 25 * MIN));
    expect(res.body.segments).toHaveLength(2);
    expect(res.body.segments.map((s: { kind: string }) => s.kind)).toEqual(['WORK', 'MEETING']);
  });

  it('is idempotent — syncing the same state twice yields the same result', async () => {
    const u = await seedUser();
    const body = createBody(u);
    await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    const sync = {
      endedAt: iso(T0 + 10 * MIN),
      segments: [{ id: fakeUlid('s'), kind: 'WORK', startedAt: iso(T0), endedAt: iso(T0 + 10 * MIN) }],
    };
    const a = await auth(request(app).put(`/v1/time-entries/${body.id}/sync`), u.accessToken).send(sync);
    const b = await auth(request(app).put(`/v1/time-entries/${body.id}/sync`), u.accessToken).send(sync);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.segments).toHaveLength(1);
    expect(b.body.endedAt).toBe(iso(T0 + 10 * MIN));
  });

  it("rejects syncing another user's entry (403)", async () => {
    const owner = await seedUser();
    const attacker = await seedUser();
    const body = createBody(owner);
    await auth(request(app).post('/v1/time-entries'), owner.accessToken).send(body);

    const res = await auth(request(app).put(`/v1/time-entries/${body.id}/sync`), attacker.accessToken).send({
      segments: [{ id: fakeUlid('s'), kind: 'WORK', startedAt: iso(T0), endedAt: null }],
    });
    expect(res.status).toBe(403);
  });

  it('404 for an unknown entry', async () => {
    const u = await seedUser();
    const res = await auth(request(app).put('/v1/time-entries/does-not-exist/sync'), u.accessToken).send({
      segments: [{ id: fakeUlid('s'), kind: 'WORK', startedAt: iso(T0), endedAt: null }],
    });
    expect(res.status).toBe(404);
  });

  it('rejects an invalid synced segment set (closed entry with open segment)', async () => {
    const u = await seedUser();
    const body = createBody(u);
    await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    const res = await auth(request(app).put(`/v1/time-entries/${body.id}/sync`), u.accessToken).send({
      endedAt: iso(T0 + 10 * MIN),
      segments: [{ id: fakeUlid('s'), kind: 'WORK', startedAt: iso(T0), endedAt: null }], // open + closed entry
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_segments');
  });
});

describe('server-authoritative clock clamp (anti-clock-tamper)', () => {
  const SKEW = 2 * 60 * 1000; // mirrors DEFAULT_CLOCK_SKEW_MS

  it('clamps a future-ended segment on create down to ~now', async () => {
    const u = await seedUser();
    const now = Date.now();
    const startMs = now - 5 * MIN; // honest recent start
    const futureEnd = now + 60 * MIN; // client clock claims +1h
    const body = createBody(u, {
      startedAtMs: startMs,
      segments: [{ id: fakeUlid('seg'), kind: 'WORK', startedAt: iso(startMs), endedAt: iso(futureEnd) }],
    });
    const res = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    expect(res.status).toBe(201);
    const persistedEnd = new Date(res.body.segments[0].endedAt).getTime();
    // Pulled back to the ceiling (≈ now + skew), nowhere near the +1h claim.
    expect(persistedEnd).toBeLessThanOrEqual(now + SKEW + 5000);
    expect(persistedEnd).toBeLessThan(futureEnd - 30 * MIN);
    // The honest start is preserved untouched.
    expect(new Date(res.body.segments[0].startedAt).getTime()).toBe(startMs);
  });

  it('leaves an honest past entry exactly as sent', async () => {
    const u = await seedUser();
    const now = Date.now();
    const startMs = now - 30 * MIN;
    const endMs = now - 20 * MIN;
    const body = createBody(u, {
      startedAtMs: startMs,
      segments: [{ id: fakeUlid('seg'), kind: 'WORK', startedAt: iso(startMs), endedAt: iso(endMs) }],
    });
    const res = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    expect(res.status).toBe(201);
    expect(res.body.segments[0].startedAt).toBe(iso(startMs));
    expect(res.body.segments[0].endedAt).toBe(iso(endMs));
  });

  it('clamps a future open-segment start on create but keeps it open', async () => {
    const u = await seedUser();
    const now = Date.now();
    const futureStart = now + 45 * MIN;
    const body = createBody(u, {
      startedAtMs: futureStart,
      segments: [{ id: fakeUlid('seg'), kind: 'WORK', startedAt: iso(futureStart), endedAt: null }],
    });
    const res = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    expect(res.status).toBe(201);
    expect(res.body.segments[0].endedAt).toBeNull();
    const persistedStart = new Date(res.body.segments[0].startedAt).getTime();
    expect(persistedStart).toBeLessThanOrEqual(now + SKEW + 5000);
    expect(persistedStart).toBeLessThan(futureStart - 30 * MIN);
  });

  it('clamps a future endedAt on sync', async () => {
    const u = await seedUser();
    const now = Date.now();
    const startMs = now - 10 * MIN;
    const body = createBody(u, {
      startedAtMs: startMs,
      segments: [{ id: fakeUlid('seg'), kind: 'WORK', startedAt: iso(startMs), endedAt: null }],
    });
    await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);

    const futureEnd = now + 120 * MIN; // client clock 2h ahead
    const sync = {
      endedAt: iso(futureEnd),
      segments: [{ id: fakeUlid('s'), kind: 'WORK', startedAt: iso(startMs), endedAt: iso(futureEnd) }],
    };
    const res = await auth(request(app).put(`/v1/time-entries/${body.id}/sync`), u.accessToken).send(sync);
    expect(res.status).toBe(200);
    const persistedEnd = new Date(res.body.endedAt).getTime();
    expect(persistedEnd).toBeLessThanOrEqual(now + SKEW + 5000);
    expect(persistedEnd).toBeLessThan(futureEnd - 60 * MIN);
    expect(new Date(res.body.segments[0].endedAt).getTime()).toBeLessThanOrEqual(now + SKEW + 5000);
  });

  it('accepts a timestamp within the skew window unchanged', async () => {
    const u = await seedUser();
    const now = Date.now();
    const startMs = now - 5 * MIN;
    const nearNow = now + 30 * 1000; // 30s ahead — inside the 2-min skew
    const body = createBody(u, {
      startedAtMs: startMs,
      segments: [{ id: fakeUlid('seg'), kind: 'WORK', startedAt: iso(startMs), endedAt: iso(nearNow) }],
    });
    const res = await auth(request(app).post('/v1/time-entries'), u.accessToken).send(body);
    expect(res.status).toBe(201);
    // Within skew → persisted verbatim.
    expect(res.body.segments[0].endedAt).toBe(iso(nearNow));
  });
});

describe('GET /v1/time-entries', () => {
  it('returns only the caller\'s entries, newest first', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    await auth(request(app).post('/v1/time-entries'), u1.accessToken).send(createBody(u1, { startedAtMs: T0 }));
    await auth(request(app).post('/v1/time-entries'), u1.accessToken).send(createBody(u1, { startedAtMs: T0 + 60 * MIN }));
    await auth(request(app).post('/v1/time-entries'), u2.accessToken).send(createBody(u2));

    const res = await auth(request(app).get('/v1/time-entries'), u1.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries.every((e: { userId: string }) => e.userId === u1.userId)).toBe(true);
    // newest first
    expect(new Date(res.body.entries[0].startedAt).getTime()).toBeGreaterThan(
      new Date(res.body.entries[1].startedAt).getTime(),
    );
  });

  it('filters by from/to window', async () => {
    const u = await seedUser();
    await auth(request(app).post('/v1/time-entries'), u.accessToken).send(createBody(u, { startedAtMs: T0 }));
    await auth(request(app).post('/v1/time-entries'), u.accessToken).send(createBody(u, { startedAtMs: T0 + 5 * 60 * MIN }));

    const res = await auth(request(app).get('/v1/time-entries'), u.accessToken).query({
      from: iso(T0 + 60 * MIN),
    });
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
  });
});
