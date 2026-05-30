import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';

/**
 * Integration tests for GET /v1/insights/day against real Postgres.
 *
 * The pure composer (`buildDayInsight`) has its own exhaustive unit suite in
 * src/insights/day.test.ts. Here we exercise the route plumbing: Postgres
 * filtering by user + window, segment join, PENDING surfacing, validation,
 * and self-scope isolation.
 */

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function ts(s: string): Date {
  return new Date(s);
}

describe('GET /v1/insights/day — validation', () => {
  it('400 on malformed date', async () => {
    const u = await seedUser();
    const res = await request(app).get('/v1/insights/day?date=05-30-2026&tz=UTC').set(auth(u.accessToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_date_or_tz');
  });

  it('400 on invalid tz', async () => {
    const u = await seedUser();
    const res = await request(app).get('/v1/insights/day?date=2026-05-30&tz=Not/A_Zone').set(auth(u.accessToken));
    expect(res.status).toBe(400);
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/v1/insights/day?date=2026-05-30');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/insights/day — empty', () => {
  it('returns a single full-day GAP block when the user has nothing tracked', async () => {
    const u = await seedUser();
    const res = await request(app).get('/v1/insights/day?date=2026-05-20&tz=UTC').set(auth(u.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.blocks).toHaveLength(1);
    expect(res.body.blocks[0].kind).toBe('GAP');
    expect(res.body.blocks[0].durationMs).toBe(24 * 60 * 60 * 1000);
    expect(res.body.pendingOverlay).toEqual([]);
    expect(res.body.firstActivityAt).toBeNull();
  });
});

describe('GET /v1/insights/day — composition with real TimeEntry rows', () => {
  it('clips a midnight-crossing entry to the requested day window (past day, no trailing gap)', async () => {
    const u = await seedUser();
    await prisma.timeEntry.create({
      data: {
        id: `te_${Date.now()}_1`,
        clientUuid: `cu_${Date.now()}_1`,
        userId: u.userId,
        source: 'AUTO',
        startedAt: ts('2026-05-19T22:00:00Z'),
        endedAt: ts('2026-05-20T01:30:00Z'),
        segments: {
          create: [{ id: `s_${Date.now()}_1`, kind: 'WORK', startedAt: ts('2026-05-19T22:00:00Z'), endedAt: ts('2026-05-20T01:30:00Z') }],
        },
      },
    });

    const res = await request(app).get('/v1/insights/day?date=2026-05-20&tz=UTC').set(auth(u.accessToken));
    expect(res.status).toBe(200);
    // [trailing GAP from previous day handled by clipping] →
    // [WORK 00:00–01:30, trailing GAP 01:30–24:00].
    expect(res.body.blocks.map((b: { kind: string }) => b.kind)).toEqual(['WORK', 'GAP']);
    const workBlock = res.body.blocks[0];
    expect(new Date(workBlock.startedAt).toISOString()).toBe('2026-05-20T00:00:00.000Z');
    expect(workBlock.durationMs).toBe(90 * 60 * 1000);
  });

  it('emits MANUAL for source=MANUAL entries and inserts a GAP between adjacent tracked entries (past day)', async () => {
    const u = await seedUser();
    await prisma.timeEntry.create({
      data: {
        id: `te_a_${Date.now()}`,
        clientUuid: `cu_a_${Date.now()}`,
        userId: u.userId,
        source: 'AUTO',
        startedAt: ts('2026-05-20T09:00:00Z'),
        endedAt: ts('2026-05-20T11:00:00Z'),
        segments: { create: [{ id: `sa_${Date.now()}`, kind: 'WORK', startedAt: ts('2026-05-20T09:00:00Z'), endedAt: ts('2026-05-20T11:00:00Z') }] },
      },
    });
    await prisma.timeEntry.create({
      data: {
        id: `te_m_${Date.now()}`,
        clientUuid: `cu_m_${Date.now()}`,
        userId: u.userId,
        source: 'MANUAL',
        larkTaskGuid: 'task_x',
        startedAt: ts('2026-05-20T12:30:00Z'),
        endedAt: ts('2026-05-20T14:00:00Z'),
        segments: { create: [{ id: `sm_${Date.now()}`, kind: 'WORK', startedAt: ts('2026-05-20T12:30:00Z'), endedAt: ts('2026-05-20T14:00:00Z') }] },
      },
    });

    const res = await request(app).get('/v1/insights/day?date=2026-05-20&tz=UTC').set(auth(u.accessToken));
    expect(res.status).toBe(200);
    // [leading GAP 12am-9am, WORK 9-11, GAP 11-12:30, MANUAL 12:30-14, trailing GAP 14-midnight]
    expect(res.body.blocks.map((b: { kind: string }) => b.kind)).toEqual(['GAP', 'WORK', 'GAP', 'MANUAL', 'GAP']);
    const interGap = res.body.blocks[2];
    expect(interGap.durationMs).toBe(90 * 60 * 1000);
    expect(res.body.totals.manualMs).toBe(90 * 60 * 1000);
  });

  it('surfaces REJECTED requests in recentRejected with decidedReason', async () => {
    const u = await seedUser();
    await prisma.manualTimeRequest.create({
      data: {
        clientUuid: `mtr_rej_${Date.now()}`,
        userId: u.userId,
        requestedStart: ts('2026-05-20T11:00:00Z'),
        requestedEnd: ts('2026-05-20T12:00:00Z'),
        reason: 'tried but rejected',
        status: 'REJECTED',
        decidedAt: ts('2026-05-20T13:00:00Z'),
        decidedReason: 'duplicate of existing entry',
      },
    });
    const res = await request(app).get('/v1/insights/day?date=2026-05-20&tz=UTC').set(auth(u.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.recentRejected).toHaveLength(1);
    expect(res.body.recentRejected[0].reason).toBe('tried but rejected');
    expect(res.body.recentRejected[0].decidedReason).toBe('duplicate of existing entry');
    // No tracked time, so blocks is just the single full-day GAP.
    expect(res.body.blocks).toHaveLength(1);
    expect(res.body.blocks[0].kind).toBe('GAP');
    expect(res.body.pendingOverlay).toHaveLength(0); // rejected != pending
  });

  it('surfaces a PENDING manual-time request as a pendingOverlay entry, not a block', async () => {
    const u = await seedUser();
    await prisma.manualTimeRequest.create({
      data: {
        clientUuid: `mtr_${Date.now()}`,
        userId: u.userId,
        requestedStart: ts('2026-05-30T10:00:00Z'),
        requestedEnd: ts('2026-05-30T11:00:00Z'),
        reason: 'forgot to start',
        status: 'PENDING',
      },
    });
    const res = await request(app).get('/v1/insights/day?date=2026-05-30&tz=UTC').set(auth(u.accessToken));
    expect(res.status).toBe(200);
    // PENDING is separate from blocks. No tracked time → single full-day gap in blocks.
    expect(res.body.blocks).toHaveLength(1);
    expect(res.body.blocks[0].kind).toBe('GAP');
    expect(res.body.pendingOverlay).toHaveLength(1);
    expect(res.body.pendingOverlay[0].reason).toBe('forgot to start');
  });

  it('adds a leading GAP from midnight and a trailing GAP to "now" when the day is today', async () => {
    const u = await seedUser();
    const today = new Date().toISOString().slice(0, 10);
    await prisma.timeEntry.create({
      data: {
        id: `te_today_${Date.now()}`,
        clientUuid: `cu_today_${Date.now()}`,
        userId: u.userId,
        source: 'AUTO',
        startedAt: ts(`${today}T06:00:00Z`),
        endedAt: ts(`${today}T07:00:00Z`),
        segments: { create: [{ id: `s_today_${Date.now()}`, kind: 'WORK', startedAt: ts(`${today}T06:00:00Z`), endedAt: ts(`${today}T07:00:00Z`) }] },
      },
    });
    const res = await request(app).get(`/v1/insights/day?date=${today}&tz=UTC`).set(auth(u.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.isToday).toBe(true);
    // [leading GAP midnight-6am, WORK 6-7am, trailing GAP 7am-now]
    expect(res.body.blocks.map((b: { kind: string }) => b.kind)).toEqual(['GAP', 'WORK', 'GAP']);
    expect(res.body.blocks[2].endedAt).toBeGreaterThan(res.body.blocks[1].endedAt);
  });

  it('does not leak another user\'s entries (self-scope)', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await prisma.timeEntry.create({
      data: {
        id: `te_iso_${Date.now()}`,
        clientUuid: `cu_iso_${Date.now()}`,
        userId: b.userId,
        source: 'AUTO',
        startedAt: ts('2026-05-30T09:00:00Z'),
        endedAt: ts('2026-05-30T10:00:00Z'),
        segments: { create: [{ id: `siso_${Date.now()}`, kind: 'WORK', startedAt: ts('2026-05-30T09:00:00Z'), endedAt: ts('2026-05-30T10:00:00Z') }] },
      },
    });
    const res = await request(app).get('/v1/insights/day?date=2026-05-30&tz=UTC').set(auth(a.accessToken));
    expect(res.status).toBe(200);
    // User A sees a single full-day gap (no tracking) — NOT user B's entry.
    expect(res.body.blocks).toHaveLength(1);
    expect(res.body.blocks[0].kind).toBe('GAP');
  });
});
