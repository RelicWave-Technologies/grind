import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { createManagedTeam } from './helpers';

/**
 * /v1/admin/manual-time-requests + /decide tests against real Postgres.
 *
 * Scenario:
 *   ws-A: admin, manager-A, member-A (in team-A), outsider (no team)
 *   ws-A: manager-B, member-B (in team-B) — for cross-team isolation
 *
 * Coverage:
 *   - GET queue: ADMIN sees all, MANAGER sees their team, MEMBER 403.
 *   - GET queue: ?status= filter.
 *   - POST decide approve: creates TimeEntry, marks APPROVED.
 *   - POST decide reject: marks REJECTED with reason, no TimeEntry.
 *   - POST decide is idempotent (second call → noop already_decided).
 *   - POST decide is scope-gated: MANAGER-B cannot decide on member-A's request.
 *   - Cross-team isolation in the LIST.
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS-mtr-${stamp}` } });
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

  const token = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });

  // A request from member-A (in team-A).
  const mtrA = await prisma.manualTimeRequest.create({
    data: {
      clientUuid: `cu-a-${stamp}`,
      userId: memA.id,
      requestedStart: new Date('2026-05-30T09:00:00Z'),
      requestedEnd: new Date('2026-05-30T10:30:00Z'),
      reason: 'Forgot to start timer for the team call',
      status: 'PENDING',
    },
  });
  // A request from member-B (in team-B).
  const mtrB = await prisma.manualTimeRequest.create({
    data: {
      clientUuid: `cu-b-${stamp}`,
      userId: memB.id,
      requestedStart: new Date('2026-05-30T11:00:00Z'),
      requestedEnd: new Date('2026-05-30T12:00:00Z'),
      reason: 'Worked through lunch on the deploy',
      status: 'PENDING',
    },
  });

  return {
    ws,
    admin: { id: admin.id, token: token(admin) },
    mgrA: { id: mgrA.id, token: token(mgrA) },
    memA: { id: memA.id, token: token(memA) },
    mgrB: { id: mgrB.id, token: token(mgrB) },
    memB: { id: memB.id, token: token(memB) },
    mtrA,
    mtrB,
  };
}

describe('GET /v1/admin/manual-time-requests', () => {
  it('MEMBER → 403', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/manual-time-requests').set(bearer(s.memA.token));
    expect(res.status).toBe(403);
  });

  it('MANAGER A → sees only member-A request', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/manual-time-requests').set(bearer(s.mgrA.token));
    expect(res.status).toBe(200);
    const ids = res.body.requests.map((r: { id: string }) => r.id);
    expect(ids).toContain(s.mtrA.id);
    expect(ids).not.toContain(s.mtrB.id);
  });

  it('ADMIN → sees both team requests', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/manual-time-requests').set(bearer(s.admin.token));
    expect(res.status).toBe(200);
    const ids = res.body.requests.map((r: { id: string }) => r.id);
    expect(ids).toContain(s.mtrA.id);
    expect(ids).toContain(s.mtrB.id);
  });

  it('?status=APPROVED filters out PENDING', async () => {
    const s = await seed();
    // Decide one as approved so we have both states.
    await request(app)
      .post(`/v1/admin/manual-time-requests/${s.mtrA.id}/decide`)
      .set(bearer(s.admin.token))
      .send({ action: 'approve' });
    const res = await request(app)
      .get('/v1/admin/manual-time-requests?status=APPROVED')
      .set(bearer(s.admin.token));
    expect(res.status).toBe(200);
    const statuses = new Set(res.body.requests.map((r: { status: string }) => r.status));
    expect(statuses.has('APPROVED')).toBe(true);
    expect(statuses.has('PENDING')).toBe(false);
  });

  it('filters by local-day range when from/to/tz are supplied', async () => {
    const s = await seed();
    const inRange = await request(app)
      .get('/v1/admin/manual-time-requests?status=ALL&from=2026-05-30&to=2026-05-30&tz=UTC')
      .set(bearer(s.admin.token));
    expect(inRange.status).toBe(200);
    const inRangeIds = new Set(inRange.body.requests.map((r: { id: string }) => r.id));
    expect(inRangeIds.has(s.mtrA.id)).toBe(true);
    expect(inRangeIds.has(s.mtrB.id)).toBe(true);
    expect(inRange.body.from).toBe('2026-05-30');
    expect(inRange.body.to).toBe('2026-05-30');
    expect(inRange.body.tz).toBe('UTC');

    const outOfRange = await request(app)
      .get('/v1/admin/manual-time-requests?status=ALL&from=2026-06-01&to=2026-06-01&tz=UTC')
      .set(bearer(s.admin.token));
    expect(outOfRange.status).toBe(200);
    const outRangeIds = new Set(outOfRange.body.requests.map((r: { id: string }) => r.id));
    expect(outRangeIds.has(s.mtrA.id)).toBe(false);
    expect(outRangeIds.has(s.mtrB.id)).toBe(false);
  });

  it('invalid status → 400', async () => {
    const s = await seed();
    const res = await request(app)
      .get('/v1/admin/manual-time-requests?status=BOGUS')
      .set(bearer(s.admin.token));
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/admin/manual-time-requests/:id/decide', () => {
  it('MANAGER A approves member-A → creates TimeEntry + marks APPROVED', async () => {
    const s = await seed();
    const res = await request(app)
      .post(`/v1/admin/manual-time-requests/${s.mtrA.id}/decide`)
      .set(bearer(s.mgrA.token))
      .send({ action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.timeEntryId).toBeTruthy();
    const te = await prisma.timeEntry.findUnique({ where: { id: res.body.timeEntryId }, include: { segments: true } });
    expect(te?.userId).toBe(s.memA.id);
    expect(te?.source).toBe('MANUAL');
    expect(te?.segments).toHaveLength(1);
    expect(te?.segments[0]?.kind).toBe('WORK');
  });

  it('reject stamps decidedReason and creates no TimeEntry', async () => {
    const s = await seed();
    const res = await request(app)
      .post(`/v1/admin/manual-time-requests/${s.mtrA.id}/decide`)
      .set(bearer(s.admin.token))
      .send({ action: 'reject', reason: 'Reason is too vague, please re-submit' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.timeEntryId).toBeNull();
    expect(res.body.decidedReason).toBe('Reason is too vague, please re-submit');
    const teCount = await prisma.timeEntry.count({ where: { userId: s.memA.id, source: 'MANUAL' } });
    expect(teCount).toBe(0);
  });

  it('MANAGER B cannot decide on member-A (out of scope) → 403-style noop', async () => {
    const s = await seed();
    const res = await request(app)
      .post(`/v1/admin/manual-time-requests/${s.mtrA.id}/decide`)
      .set(bearer(s.mgrB.token))
      .send({ action: 'approve' });
    expect(res.status).toBe(403);
    const reloaded = await prisma.manualTimeRequest.findUnique({ where: { id: s.mtrA.id } });
    expect(reloaded?.status).toBe('PENDING');
  });

  it('ADMIN can decide their own manual-time request', async () => {
    const s = await seed();
    const selfReq = await prisma.manualTimeRequest.create({
      data: {
        clientUuid: `cu-self-${Date.now()}`,
        userId: s.admin.id,
        approverId: s.admin.id,
        requestedStart: new Date('2026-05-30T13:00:00Z'),
        requestedEnd: new Date('2026-05-30T14:00:00Z'),
        reason: 'Own admin request',
        status: 'PENDING',
      },
    });
    const res = await request(app)
      .post(`/v1/admin/manual-time-requests/${selfReq.id}/decide`)
      .set(bearer(s.admin.token))
      .send({ action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.timeEntryId).toBeTruthy();
    const reloaded = await prisma.manualTimeRequest.findUnique({ where: { id: selfReq.id } });
    expect(reloaded?.status).toBe('APPROVED');
    expect(reloaded?.timeEntryId).toBeTruthy();
  });

  it('MANAGER can decide their own manual-time request', async () => {
    const s = await seed();
    const selfReq = await prisma.manualTimeRequest.create({
      data: {
        clientUuid: `cu-mgr-self-${Date.now()}`,
        userId: s.mgrA.id,
        approverId: s.mgrA.id,
        requestedStart: new Date('2026-05-30T13:00:00Z'),
        requestedEnd: new Date('2026-05-30T14:00:00Z'),
        reason: 'Own manager request',
        status: 'PENDING',
      },
    });
    const res = await request(app)
      .post(`/v1/admin/manual-time-requests/${selfReq.id}/decide`)
      .set(bearer(s.mgrA.token))
      .send({ action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.timeEntryId).toBeTruthy();
    const reloaded = await prisma.manualTimeRequest.findUnique({ where: { id: selfReq.id } });
    expect(reloaded?.status).toBe('APPROVED');
    expect(reloaded?.timeEntryId).toBeTruthy();
  });

  it('idempotent: deciding twice returns the already-decided state (no double TimeEntry)', async () => {
    const s = await seed();
    const r1 = await request(app)
      .post(`/v1/admin/manual-time-requests/${s.mtrA.id}/decide`)
      .set(bearer(s.admin.token))
      .send({ action: 'approve' });
    expect(r1.status).toBe(200);
    const r2 = await request(app)
      .post(`/v1/admin/manual-time-requests/${s.mtrA.id}/decide`)
      .set(bearer(s.admin.token))
      .send({ action: 'reject' });
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('APPROVED'); // unchanged
    expect(r2.body.noop).toBe('already_decided');
    const teCount = await prisma.timeEntry.count({ where: { clientUuid: `mtr-${s.mtrA.id}` } });
    expect(teCount).toBe(1);
  });

  it('invalid action → 400', async () => {
    const s = await seed();
    const res = await request(app)
      .post(`/v1/admin/manual-time-requests/${s.mtrA.id}/decide`)
      .set(bearer(s.admin.token))
      .send({ action: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('not_found for unknown id', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/admin/manual-time-requests/nope/decide')
      .set(bearer(s.admin.token))
      .send({ action: 'approve' });
    expect(res.status).toBe(404);
  });
});
