import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { createManagedTeam } from './helpers';

/**
 * /v1/admin/timesheets integration tests against real Postgres.
 *
 * Verifies the matrix endpoint produces correct totals across:
 *   - scope (MANAGER sees their team only, ADMIN sees all)
 *   - kind (WORK / MEETING / MANUAL → distinct buckets)
 *   - range validation (default 14d, max 60d, invalid tz)
 *   - 403 for MEMBERs (their My Day endpoint already handles self-view)
 */

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS-ts-${stamp}` } });
  const mk = (email: string, name: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `${email}-${stamp}@test.local`,
        name,
        role,
        passwordHash: 'x'.repeat(60),
      },
    });
  const admin = await mk('admin', 'Alice Admin', 'ADMIN');
  const mgrA = await mk('mgr-a', 'Mira Manager A', 'MANAGER');
  const memA = await mk('mem-a', 'Mia Member A', 'MEMBER');
  const mgrB = await mk('mgr-b', 'Mark Manager B', 'MANAGER');
  const memB = await mk('mem-b', 'Bob Member B', 'MEMBER');

  const teamA = await createManagedTeam({ workspaceId: ws.id, name: 'A', managerId: mgrA.id });
  await prisma.user.updateMany({ where: { id: { in: [mgrA.id, memA.id] } }, data: { teamId: teamA.id } });
  const teamB = await createManagedTeam({ workspaceId: ws.id, name: 'B', managerId: mgrB.id });
  await prisma.user.updateMany({ where: { id: { in: [mgrB.id, memB.id] } }, data: { teamId: teamB.id } });

  // member-A: 90 min WORK + 30 min MEETING on May 26 UTC.
  const memAEntry = await prisma.timeEntry.create({
    data: {
      id: `te-a1-${stamp}`,
      clientUuid: `cu-a1-${stamp}`,
      userId: memA.id,
      source: 'AUTO',
      startedAt: new Date('2026-05-26T09:00:00Z'),
      endedAt: new Date('2026-05-26T11:00:00Z'),
      segments: {
        create: [
          { id: `s-a1w-${stamp}`, kind: 'WORK', startedAt: new Date('2026-05-26T09:00:00Z'), endedAt: new Date('2026-05-26T10:30:00Z') },
          { id: `s-a1m-${stamp}`, kind: 'MEETING', startedAt: new Date('2026-05-26T10:30:00Z'), endedAt: new Date('2026-05-26T11:00:00Z') },
        ],
      },
    },
  });
  await prisma.activitySample.createMany({
    data: [
      {
        id: `as-a1-${stamp}`,
        userId: memA.id,
        timeEntryId: memAEntry.id,
        bucketStart: new Date('2026-05-26T09:15:00Z'),
        keystrokes: 8,
        clicks: 2,
        mouseDistancePx: 240,
        scrollEvents: 1,
      },
      {
        id: `as-a2-${stamp}`,
        userId: memA.id,
        timeEntryId: memAEntry.id,
        bucketStart: new Date('2026-05-26T09:16:00Z'),
        keystrokes: 5,
        clicks: 1,
        mouseDistancePx: 140,
        scrollEvents: 0,
      },
    ],
  });
  // member-A: 60 min MANUAL on May 27.
  await prisma.timeEntry.create({
    data: {
      id: `te-a2-${stamp}`,
      clientUuid: `cu-a2-${stamp}`,
      userId: memA.id,
      source: 'MANUAL',
      startedAt: new Date('2026-05-27T14:00:00Z'),
      endedAt: new Date('2026-05-27T15:00:00Z'),
      segments: {
        create: [
          { id: `s-a2-${stamp}`, kind: 'WORK', startedAt: new Date('2026-05-27T14:00:00Z'), endedAt: new Date('2026-05-27T15:00:00Z') },
        ],
      },
    },
  });
  // member-B: 45 min WORK on May 26 UTC.
  await prisma.timeEntry.create({
    data: {
      id: `te-b1-${stamp}`,
      clientUuid: `cu-b1-${stamp}`,
      userId: memB.id,
      source: 'AUTO',
      startedAt: new Date('2026-05-26T13:00:00Z'),
      endedAt: new Date('2026-05-26T13:45:00Z'),
      segments: {
        create: [{ id: `s-b1-${stamp}`, kind: 'WORK', startedAt: new Date('2026-05-26T13:00:00Z'), endedAt: new Date('2026-05-26T13:45:00Z') }],
      },
    },
  });

  const tok = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });

  return {
    workspaceId: ws.id,
    admin: { id: admin.id, token: tok(admin) },
    mgrA: { id: mgrA.id, token: tok(mgrA) },
    memA: { id: memA.id, token: tok(memA) },
    mgrB: { id: mgrB.id, token: tok(mgrB) },
    memB: { id: memB.id, token: tok(memB) },
  };
}

describe('GET /v1/admin/timesheets', () => {
  it('MEMBER → 403', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets?from=2026-05-26&to=2026-05-27&tz=UTC')
      .set(auth(s.memA.token));
    expect(res.status).toBe(403);
  });

  it('MANAGER A → sees only member-A + self; correct kind buckets', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets?from=2026-05-26&to=2026-05-27&tz=UTC')
      .set(auth(s.mgrA.token));
    expect(res.status).toBe(200);
    expect(res.body.days).toEqual(['2026-05-26', '2026-05-27']);
    const userIds = new Set(res.body.users.map((u: { id: string }) => u.id));
    expect(userIds.has(s.mgrA.id)).toBe(true);
    expect(userIds.has(s.memA.id)).toBe(true);
    expect(userIds.has(s.memB.id)).toBe(false);
    // member-A: 90 min worked + 30 min meeting on May 26.
    expect(res.body.cells[s.memA.id]['2026-05-26'].workedMs).toBe(90 * 60 * 1000);
    expect(res.body.cells[s.memA.id]['2026-05-26'].meetingMs).toBe(30 * 60 * 1000);
    expect(res.body.cells[s.memA.id]['2026-05-26'].totalMs).toBe(120 * 60 * 1000);
    // member-A: 60 min MANUAL on May 27.
    expect(res.body.cells[s.memA.id]['2026-05-27'].manualMs).toBe(60 * 60 * 1000);
    expect(res.body.cells[s.memA.id]['2026-05-27'].workedMs).toBe(0);
  });

  it('ADMIN → sees both teams\' totals', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets?from=2026-05-26&to=2026-05-27&tz=UTC')
      .set(auth(s.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.cells[s.memA.id]['2026-05-26'].workedMs).toBe(90 * 60 * 1000);
    expect(res.body.cells[s.memB.id]['2026-05-26'].workedMs).toBe(45 * 60 * 1000);
  });

  it('MANAGER B (cross-team) → does NOT see member-A in cells', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets?from=2026-05-26&to=2026-05-27&tz=UTC')
      .set(auth(s.mgrB.token));
    expect(res.status).toBe(200);
    expect(res.body.cells[s.memA.id]).toBeUndefined();
    expect(res.body.cells[s.memB.id]?.['2026-05-26']?.workedMs).toBe(45 * 60 * 1000);
  });

  it('invalid tz → 400', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets?from=2026-05-26&to=2026-05-27&tz=Not/Real')
      .set(auth(s.admin.token));
    expect(res.status).toBe(400);
  });

  it('range_too_long → 400 when > 60 days', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets?from=2025-01-01&to=2026-06-01&tz=UTC')
      .set(auth(s.admin.token));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('range_too_long');
  });

  it('inverted range → 400', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets?from=2026-05-27&to=2026-05-26&tz=UTC')
      .set(auth(s.admin.token));
    expect(res.status).toBe(400);
  });

  it('default range without ?from/?to returns 14 days ending today', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/timesheets').set(auth(s.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(14);
  });

  it('cell now carries firstActivityMs / lastActivityMs', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets?from=2026-05-26&to=2026-05-27&tz=UTC')
      .set(auth(s.admin.token));
    expect(res.status).toBe(200);
    const cell = res.body.cells[s.memA.id]['2026-05-26'];
    expect(cell.firstActivityMs).toBe(new Date('2026-05-26T09:00:00Z').getTime());
    expect(cell.lastActivityMs).toBe(new Date('2026-05-26T11:00:00Z').getTime());
  });

  it('cell carries activitySampleCount for evidence-aware attendance', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets?from=2026-05-26&to=2026-05-27&tz=UTC')
      .set(auth(s.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.cells[s.memA.id]['2026-05-26'].activitySampleCount).toBe(2);
    expect(res.body.cells[s.memB.id]['2026-05-26'].activitySampleCount).toBe(0);
    expect(res.body.cells[s.memA.id]['2026-05-27'].activitySampleCount).toBe(0);
  });

  it('excludes invalidated time and samples from the matrix', async () => {
    const s = await seed();
    const flag = await prisma.activityFlag.create({
      data: {
        userId: s.memA.id,
        type: 'METRONOMIC',
        windowStart: new Date('2026-05-26T09:15:00Z'),
        windowEnd: new Date('2026-05-26T09:17:00Z'),
        riskScore: 60,
        evidence: {},
        status: 'RESOLVED',
        resolution: 'TIME_INVALIDATED',
        resolvedById: s.admin.id,
        resolvedAt: new Date('2026-05-26T09:20:00Z'),
        resolvedNote: 'Confirmed macro',
      },
    });
    await prisma.timeInvalidation.create({
      data: {
        workspaceId: s.workspaceId,
        flagId: flag.id,
        userId: s.memA.id,
        windowStart: flag.windowStart,
        windowEnd: flag.windowEnd,
        invalidatedById: s.admin.id,
        reason: 'Confirmed macro',
      },
    });

    const res = await request(app)
      .get('/v1/admin/timesheets?from=2026-05-26&to=2026-05-26&tz=UTC')
      .set(auth(s.admin.token));
    expect(res.status).toBe(200);
    const cell = res.body.cells[s.memA.id]['2026-05-26'];
    expect(cell.workedMs).toBe(88 * 60 * 1000);
    expect(cell.meetingMs).toBe(30 * 60 * 1000);
    expect(cell.invalidatedMs).toBe(2 * 60 * 1000);
    expect(cell.totalMs).toBe(118 * 60 * 1000);
    expect(cell.activitySampleCount).toBe(0);
  });
});

describe('GET /v1/admin/timesheets.csv', () => {
  it('MEMBER → 403', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets.csv?from=2026-05-26&to=2026-05-27&tz=UTC')
      .set(auth(s.memA.token));
    expect(res.status).toBe(403);
  });

  it('emits a header row + one row per non-empty (user, day), scoped to caller', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets.csv?from=2026-05-26&to=2026-05-27&tz=UTC')
      .set(auth(s.admin.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('timesheets-2026-05-26-to-2026-05-27.csv');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('name,email,role,day,worked_h,meeting_h,manual_h,total_h,invalidated_h,first_activity,last_activity,activity_samples');
    // 3 active (user, day) pairs from the seed: memA on May 26, memA on May 27, memB on May 26.
    expect(lines.length).toBe(1 + 3);
    // Spot-check a known cell: memA on May 26 = 1.50 worked + 0.50 meeting = 2.00 total.
    const memARowMay26 = lines.find((l) => l.startsWith('Mia Member A') && l.includes('2026-05-26'))!;
    expect(memARowMay26).toBeTruthy();
    const cells = memARowMay26.split(',');
    expect(cells[4]).toBe('1.50'); // worked_h
    expect(cells[5]).toBe('0.50'); // meeting_h
    expect(cells[7]).toBe('2.00'); // total_h
    expect(cells[8]).toBe('0.00'); // invalidated_h
    expect(cells[9]).toBe('09:00'); // first_activity
    expect(cells[10]).toBe('11:00'); // last_activity
    expect(cells[11]).toBe('2'); // activity_samples
  });

  it('manager scope filters out the other team in CSV too', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets.csv?from=2026-05-26&to=2026-05-27&tz=UTC')
      .set(auth(s.mgrA.token));
    expect(res.status).toBe(200);
    // No row should mention Bob Member B.
    expect(res.text).not.toContain('Bob Member B');
    expect(res.text).toContain('Mia Member A');
  });

  it('quotes commas in names', async () => {
    const s = await seed();
    // Rename memA to include a comma; CSV must quote.
    await prisma.user.update({ where: { id: s.memA.id }, data: { name: 'Mia, the Member' } });
    const res = await request(app)
      .get('/v1/admin/timesheets.csv?from=2026-05-26&to=2026-05-27&tz=UTC')
      .set(auth(s.admin.token));
    expect(res.status).toBe(200);
    expect(res.text).toContain('"Mia, the Member"');
  });

  it('invalid range → 400 (same validation as JSON endpoint)', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/timesheets.csv?from=2026-05-27&to=2026-05-26&tz=UTC')
      .set(auth(s.admin.token));
    expect(res.status).toBe(400);
  });
});
