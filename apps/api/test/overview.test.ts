import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { ulid } from 'ulid';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-ov`;
  const ws = await prisma.workspace.create({ data: { name: `WS ${stamp}` } });
  const mk = (email: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `${email}-${stamp}@test.local`,
        name: email,
        role,
        passwordHash: 'x'.repeat(60),
      },
    });
  const admin = await mk('admin', 'ADMIN');
  const mgr = await mk('mgr', 'MANAGER');
  const m1 = await mk('m1', 'MEMBER');
  const m2 = await mk('m2', 'MEMBER');
  const outsider = await mk('out', 'MEMBER');

  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Squad', managerId: mgr.id } });
  await prisma.user.updateMany({ where: { id: { in: [mgr.id, m1.id, m2.id] } }, data: { teamId: team.id } });

  const token = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });
  return {
    ws,
    admin: { id: admin.id, token: token(admin) },
    mgr: { id: mgr.id, token: token(mgr) },
    m1: { id: m1.id, token: token(m1) },
    m2: { id: m2.id, token: token(m2) },
    outsider: { id: outsider.id, token: token(outsider) },
  };
}

async function seedSegment(opts: {
  userId: string;
  source: 'AUTO' | 'MANUAL';
  kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED';
  startedAt: Date;
  endedAt: Date;
}) {
  return prisma.timeEntry.create({
    data: {
      id: ulid(),
      clientUuid: ulid(),
      userId: opts.userId,
      source: opts.source,
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      segments: {
        create: [{ id: ulid(), kind: opts.kind, startedAt: opts.startedAt, endedAt: opts.endedAt }],
      },
    },
  });
}

async function pending(userId: string, ageMs: number) {
  const now = Date.now();
  const start = now - ageMs - 2 * HOUR;
  return prisma.manualTimeRequest.create({
    data: {
      clientUuid: ulid(),
      userId,
      status: 'PENDING',
      requestedStart: new Date(start),
      requestedEnd: new Date(start + HOUR),
      reason: 'forgot',
      createdAt: new Date(now - ageMs),
    },
  });
}

/**
 * Build a series of "today" segment windows anchored backward from
 * `now - 60s`. Avoids today/yesterday UTC boundary issues by capping
 * the total stretch at 30 minutes (deep into any UTC hour).
 */
function pastSlot(endOffsetMs: number, durMs: number): { startedAt: Date; endedAt: Date } {
  const now = Date.now();
  const end = now - 60_000 - endOffsetMs; // 1 minute back is the latest we'll go
  const start = end - durMs;
  return { startedAt: new Date(start), endedAt: new Date(end) };
}

describe('GET /v1/admin/overview', () => {
  it('rejects MEMBER (manager+ only)', async () => {
    const { outsider } = await seed();
    const res = await request(app).get('/v1/admin/overview').set(bearer(outsider.token));
    expect(res.status).toBe(403);
  });

  it('returns scope=workspace for ADMIN with empty state', async () => {
    const { admin } = await seed();
    const res = await request(app).get('/v1/admin/overview?tz=UTC').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('workspace');
    expect(res.body.today.activeUsers).toBe(0);
    expect(res.body.today.workedHours).toBe(0);
    expect(res.body.approvals.pendingTotal).toBe(0);
    expect(res.body.flags.openTotal).toBe(0);
  });

  it('returns scope=team for MANAGER and only counts their team', async () => {
    const { mgr, m1, outsider } = await seed();
    // 15-min window ending 1 min ago for both users.
    const slot = pastSlot(0, 15 * MIN);
    await seedSegment({ userId: m1.id, source: 'AUTO', kind: 'WORK', ...slot });
    await seedSegment({ userId: outsider.id, source: 'AUTO', kind: 'WORK', ...slot });

    const res = await request(app).get('/v1/admin/overview?tz=UTC').set(bearer(mgr.token));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('team');
    expect(res.body.today.activeUsers).toBe(1); // only m1, outsider excluded
    expect(res.body.today.workedHours).toBeGreaterThan(0);
  });

  it('splits hours by source/kind (WORK / MEETING / MANUAL)', async () => {
    const { admin, m1 } = await seed();
    // 30-min WORK / 20-min MEETING / 10-min MANUAL, all within the last hour.
    await seedSegment({ userId: m1.id, source: 'AUTO', kind: 'WORK', ...pastSlot(30 * MIN, 30 * MIN) });
    await seedSegment({ userId: m1.id, source: 'AUTO', kind: 'MEETING', ...pastSlot(10 * MIN, 20 * MIN) });
    await seedSegment({ userId: m1.id, source: 'MANUAL', kind: 'WORK', ...pastSlot(0, 10 * MIN) });

    const res = await request(app).get('/v1/admin/overview?tz=UTC').set(bearer(admin.token));
    expect(res.body.today.workedHours).toBeCloseTo(0.5, 1);
    expect(res.body.today.meetingHours).toBeCloseTo(0.33, 1);
    expect(res.body.today.manualHours).toBeCloseTo(0.17, 1);
  });

  it('counts pending approvals + flags stuck items', async () => {
    const { admin, m1 } = await seed();
    await pending(m1.id, 1 * HOUR);
    await pending(m1.id, 60 * HOUR); // stuck
    await pending(m1.id, 70 * HOUR); // stuck

    const res = await request(app).get('/v1/admin/overview').set(bearer(admin.token));
    expect(res.body.approvals.pendingTotal).toBe(3);
    expect(res.body.approvals.pendingStuck).toBe(2);
    expect(res.body.approvals.oldestPendingAgeMs).toBeGreaterThan(60 * HOUR);
  });

  it('surfaces open ActivityFlags with riskScore + creator info', async () => {
    const { admin, m1 } = await seed();
    await prisma.activityFlag.create({
      data: {
        userId: m1.id,
        type: 'METRONOMIC',
        windowStart: new Date(Date.now() - HOUR),
        windowEnd: new Date(),
        status: 'OPEN',
        riskScore: 81, // 0–100 (Int)
        evidence: { ikiCv: 0.02 },
      },
    });
    const res = await request(app).get('/v1/admin/overview').set(bearer(admin.token));
    expect(res.body.flags.openTotal).toBe(1);
    expect(res.body.flags.recent[0]).toMatchObject({
      type: 'METRONOMIC',
      user: { id: m1.id },
      riskScore: 81,
    });
  });

  it('isolates per workspace', async () => {
    const a = await seed();
    const b = await seed();
    await pending(b.m1.id, 60 * HOUR);
    const res = await request(app).get('/v1/admin/overview').set(bearer(a.admin.token));
    expect(res.body.approvals.pendingTotal).toBe(0);
  });
});
