import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { createManagedTeam, seedUser } from './helpers';
import { signAccessToken } from '../src/lib/jwt';

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

  it('uses the workspace timezone even when an older client sends a different valid device timezone', async () => {
    const u = await seedUser();
    await prisma.workspace.update({
      where: { id: u.workspaceId },
      data: { timezone: 'Asia/Kolkata' },
    });

    const res = await request(app)
      .get('/v1/insights/day?date=2026-07-14&tz=America/Los_Angeles')
      .set(auth(u.accessToken));

    expect(res.status).toBe(200);
    expect(new Date(res.body.dayStart).toISOString()).toBe('2026-07-13T18:30:00.000Z');
    expect(new Date(res.body.dayEnd).toISOString()).toBe('2026-07-14T18:30:00.000Z');
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
    // No tracked time + rejected (not pending) → single full-day GAP, no PENDING block.
    expect(res.body.blocks).toHaveLength(1);
    expect(res.body.blocks[0].kind).toBe('GAP');
    expect(res.body.blocks.some((b: { kind: string }) => b.kind === 'PENDING')).toBe(false);
  });

  it('carves a PENDING manual-time request into the partition as a PENDING block (no overlay, no duplicacy)', async () => {
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
    // Single partition: GAP(00–10) · PENDING(10–11) · GAP(11–24).
    expect(res.body.blocks.map((b: { kind: string }) => b.kind)).toEqual(['GAP', 'PENDING', 'GAP']);
    const pending = res.body.blocks.find((b: { kind: string }) => b.kind === 'PENDING');
    expect(pending.reason).toBe('forgot to start');
    expect(pending.requestId).toBeTruthy();
  });

  it('caps "today" at the present — the partition ends at now, not midnight', async () => {
    const u = await seedUser();
    // Seed relative to `now` (a 1-min WORK block that ended 2 min ago) so this
    // never depends on the wall-clock time of day. The pure builder suite covers
    // the exact leading/trailing-gap structure deterministically.
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    // Trailing gap (wEnd → now) must stay > the 2-min coalesce threshold so it
    // remains its own block rather than folding into the WORK.
    const wStart = new Date(now.getTime() - 10 * 60_000);
    const wEnd = new Date(now.getTime() - 5 * 60_000);
    await prisma.timeEntry.create({
      data: {
        id: `te_today_${Date.now()}`,
        clientUuid: `cu_today_${Date.now()}`,
        userId: u.userId,
        source: 'AUTO',
        startedAt: wStart,
        endedAt: wEnd,
        segments: { create: [{ id: `s_today_${Date.now()}`, kind: 'WORK', startedAt: wStart, endedAt: wEnd }] },
      },
    });
    const res = await request(app).get(`/v1/insights/day?date=${today}&tz=UTC`).set(auth(u.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.isToday).toBe(true);
    expect(res.body.blocks.filter((b: { kind: string }) => b.kind === 'WORK')).toHaveLength(1);
    // The final block is a trailing GAP capped at ~now (not the calendar midnight).
    const last = res.body.blocks[res.body.blocks.length - 1];
    expect(last.kind).toBe('GAP');
    expect(Math.abs(last.endedAt - Date.now())).toBeLessThan(5000);
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

describe('GET /v1/insights/day — scoped ?userId=', () => {
  /**
   * Build a workspace with admin + manager-A + member-A (in team-A) +
   * manager-B + member-B (in team-B). Drop a TimeEntry on member-A's
   * 2026-05-30 so the day has content to find.
   */
  async function seedScope() {
    const stamp = Date.now();
    const ws = await prisma.workspace.create({ data: { name: `WS-scope-${stamp}` } });
    const mk = (role: 'ADMIN' | 'MANAGER' | 'MEMBER', tag: string) =>
      prisma.user.create({
        data: {
          workspaceId: ws.id,
          email: `${tag}-${stamp}@test.local`,
          name: `${tag} user`,
          role,
          passwordHash: 'x'.repeat(60),
        },
      });
    const admin = await mk('ADMIN', 'admin');
    const mgrA = await mk('MANAGER', 'mgr-a');
    const memA = await mk('MEMBER', 'mem-a');
    const mgrB = await mk('MANAGER', 'mgr-b');
    const memB = await mk('MEMBER', 'mem-b');
    const teamA = await createManagedTeam({ workspaceId: ws.id, name: 'A', managerId: mgrA.id });
    await prisma.user.updateMany({ where: { id: { in: [mgrA.id, memA.id] } }, data: { teamId: teamA.id } });
    const teamB = await createManagedTeam({ workspaceId: ws.id, name: 'B', managerId: mgrB.id });
    await prisma.user.updateMany({ where: { id: { in: [mgrB.id, memB.id] } }, data: { teamId: teamB.id } });
    // Member-A has tracked time on 2026-05-30.
    await prisma.timeEntry.create({
      data: {
        id: `te_scope_${stamp}`,
        clientUuid: `cu_scope_${stamp}`,
        userId: memA.id,
        source: 'AUTO',
        startedAt: ts('2026-05-30T09:00:00Z'),
        endedAt: ts('2026-05-30T11:00:00Z'),
        segments: {
          create: [
            {
              id: `sscope_${stamp}`,
              kind: 'WORK',
              startedAt: ts('2026-05-30T09:00:00Z'),
              endedAt: ts('2026-05-30T11:00:00Z'),
            },
          ],
        },
      },
    });
    const tok = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
      signAccessToken({ sub: u.id, ws: ws.id, role: u.role });
    return {
      ws,
      admin: { id: admin.id, token: tok(admin) },
      mgrA: { id: mgrA.id, token: tok(mgrA) },
      memA: { id: memA.id, token: tok(memA) },
      mgrB: { id: mgrB.id, token: tok(mgrB) },
      memB: { id: memB.id, token: tok(memB) },
    };
  }

  it('member-A views own day without ?userId → returns their tracked time', async () => {
    const s = await seedScope();
    const res = await request(app)
      .get('/v1/insights/day?date=2026-05-30&tz=UTC')
      .set(auth(s.memA.token));
    expect(res.status).toBe(200);
    const tracked = res.body.blocks.filter((b: { kind: string }) => b.kind === 'WORK');
    expect(tracked.length).toBeGreaterThanOrEqual(1);
  });

  it('manager-A views member-A?userId=...  → permitted, returns tracked time', async () => {
    const s = await seedScope();
    const res = await request(app)
      .get(`/v1/insights/day?date=2026-05-30&tz=UTC&userId=${s.memA.id}`)
      .set(auth(s.mgrA.token));
    expect(res.status).toBe(200);
    const tracked = res.body.blocks.filter((b: { kind: string }) => b.kind === 'WORK');
    expect(tracked.length).toBeGreaterThanOrEqual(1);
  });

  it('manager-B views member-A → 403 (not in scope)', async () => {
    const s = await seedScope();
    const res = await request(app)
      .get(`/v1/insights/day?date=2026-05-30&tz=UTC&userId=${s.memA.id}`)
      .set(auth(s.mgrB.token));
    expect(res.status).toBe(403);
  });

  it('admin views member-A → permitted', async () => {
    const s = await seedScope();
    const res = await request(app)
      .get(`/v1/insights/day?date=2026-05-30&tz=UTC&userId=${s.memA.id}`)
      .set(auth(s.admin.token));
    expect(res.status).toBe(200);
    const tracked = res.body.blocks.filter((b: { kind: string }) => b.kind === 'WORK');
    expect(tracked.length).toBeGreaterThanOrEqual(1);
  });

  it('member-A passes their own userId explicitly → still allowed', async () => {
    const s = await seedScope();
    const res = await request(app)
      .get(`/v1/insights/day?date=2026-05-30&tz=UTC&userId=${s.memA.id}`)
      .set(auth(s.memA.token));
    expect(res.status).toBe(200);
  });

  it('member-A passes a different userId → 403', async () => {
    const s = await seedScope();
    const res = await request(app)
      .get(`/v1/insights/day?date=2026-05-30&tz=UTC&userId=${s.memB.id}`)
      .set(auth(s.memA.token));
    expect(res.status).toBe(403);
  });
});
