import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

/**
 * The role × action matrix (docs/rbac-matrix.md), walked per role. Every
 * endpoint that changes somebody's records is tried by the people who must be
 * refused — an HR without a team, an HR outside her team, a manager on another
 * team, a member on anyone, HR on an admin — and by the ones who must not be.
 * HR's extra is People alone: her reports are her position's.
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let n = 0;
async function person(workspaceId: string, name: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER' | 'HR', extra: { teamId?: string; provisioningStatus?: 'PENDING' | 'ACTIVE' } = {}) {
  n += 1;
  const user = await prisma.user.create({
    data: {
      workspaceId,
      email: `rbac-${n}-${Date.now()}@test.local`,
      name,
      role,
      provisioningStatus: extra.provisioningStatus ?? 'ACTIVE',
      passwordHash: 'x'.repeat(60),
      teamId: extra.teamId ?? null,
    },
  });
  return { id: user.id, token: signAccessToken({ sub: user.id, ws: workspaceId, role }) };
}

async function team(workspaceId: string, name: string, managerId: string) {
  const t = await prisma.team.create({ data: { workspaceId, name } });
  await prisma.teamManager.create({ data: { workspaceId, teamId: t.id, userId: managerId } });
  await prisma.user.update({ where: { id: managerId }, data: { teamId: t.id } });
  return t;
}

async function pendingRequest(userId: string, hour: number) {
  return prisma.manualTimeRequest.create({
    data: {
      clientUuid: `rbac-mtr-${userId}-${hour}`,
      userId,
      requestedStart: new Date(Date.UTC(2026, 8, 10, hour, 0)),
      requestedEnd: new Date(Date.UTC(2026, 8, 10, hour, 30)),
      reason: 'Forgot the timer',
      status: 'PENDING',
    },
  });
}

async function flag(userId: string, minute: number) {
  const windowStart = new Date(Date.UTC(2026, 8, 10, 9, minute));
  return prisma.activityFlag.create({
    data: { userId, type: 'METRONOMIC', windowStart, windowEnd: new Date(windowStart.getTime() + 30 * 60_000), riskScore: 60, evidence: {} },
  });
}

/**
 * Admin; manager A with member A; HR "lead" managing team H with member H; HR
 * with no team; a second HR; a member outside every team.
 */
async function seed() {
  const ws = await prisma.workspace.create({ data: { name: `RBAC ${Date.now()}` } });
  const w = ws.id;
  const admin = await person(w, 'Admin', 'ADMIN');
  const mgrA = await person(w, 'Manager A', 'MANAGER');
  const teamA = await team(w, 'Team A', mgrA.id);
  const memA = await person(w, 'Member A', 'MEMBER', { teamId: teamA.id });
  const hrLead = await person(w, 'HR Lead', 'HR');
  const teamH = await team(w, 'Team H', hrLead.id);
  const memH = await person(w, 'Member H', 'MEMBER', { teamId: teamH.id });
  const hr = await person(w, 'HR Solo', 'HR');
  const hr2 = await person(w, 'HR Two', 'HR');
  const loner = await person(w, 'Loner', 'MEMBER');
  return { w, admin, mgrA, teamA, memA, hrLead, teamH, memH, hr, hr2, loner };
}

const override = (userId: string) => ({ userId, date: '2026-09-10', code: 'P', reason: 'Was at a client site' });
const manualTime = (userId: string, tag: string) => ({
  clientUuid: `rbac-create-${tag}-${userId}`,
  userId,
  requestedStart: '2026-09-10T05:00:00.000Z',
  requestedEnd: '2026-09-10T05:30:00.000Z',
  reason: 'Client call',
});

describe('HR runs People — never on an admin or another HR', () => {
  it('invites only members', async () => {
    const s = await seed();
    const ok = await request(app).post('/v1/admin/users').set(bearer(s.hr.token))
      .send({ email: `new-${Date.now()}@test.local`, name: 'New Person' });
    expect(ok.status).toBe(201);
    expect(ok.body.role).toBe('MEMBER');
    for (const role of ['ADMIN', 'HR']) {
      const res = await request(app).post('/v1/admin/users').set(bearer(s.hr.token))
        .send({ email: `x-${role}-${Date.now()}@test.local`, name: 'Nope', role });
      expect(res.status).toBe(403);
    }
  });

  it('edits, suspends, reactivates and activates members', async () => {
    const s = await seed();
    const pending = await person(s.w, 'Waiting', 'MEMBER', { provisioningStatus: 'PENDING' });
    expect((await request(app).patch(`/v1/admin/users/${s.memA.id}`).set(bearer(s.hr.token)).send({ name: 'Renamed' })).status).toBe(200);
    expect((await request(app).post(`/v1/admin/users/${s.loner.id}/deactivate`).set(bearer(s.hr.token))).status).toBe(200);
    expect((await request(app).post(`/v1/admin/users/${s.loner.id}/reactivate`).set(bearer(s.hr.token))).status).toBe(200);
    expect((await request(app).post(`/v1/admin/users/${pending.id}/activate`).set(bearer(s.hr.token))).status).toBe(200);
  });

  it('cannot touch an admin or another HR, or hand out either role', async () => {
    const s = await seed();
    for (const target of [s.admin.id, s.hr2.id]) {
      expect((await request(app).patch(`/v1/admin/users/${target}`).set(bearer(s.hr.token)).send({ name: 'X' })).body.error).toBe('admin_only_target');
      expect((await request(app).post(`/v1/admin/users/${target}/deactivate`).set(bearer(s.hr.token))).status).toBe(403);
      expect((await request(app).post(`/v1/admin/users/${target}/reactivate`).set(bearer(s.hr.token))).status).toBe(403);
      expect((await request(app).post(`/v1/admin/users/${target}/activate`).set(bearer(s.hr.token))).status).toBe(403);
    }
    for (const role of ['ADMIN', 'HR']) {
      const res = await request(app).patch(`/v1/admin/users/${s.memA.id}`).set(bearer(s.hr.token)).send({ role });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('role_not_allowed');
    }
    const after = await prisma.user.findUniqueOrThrow({ where: { id: s.memA.id } });
    expect(after.role).toBe('MEMBER');
  });

  it('cannot hard-delete, or set the idle countdown (a monitoring setting)', async () => {
    const s = await seed();
    expect((await request(app).get(`/v1/admin/users/${s.loner.id}/deletion-plan`).set(bearer(s.hr.token))).status).toBe(403);
    expect((await request(app).delete(`/v1/admin/users/${s.loner.id}`).set(bearer(s.hr.token)).send({ confirmEmail: 'x' })).status).toBe(403);
    const idle = await request(app).patch(`/v1/admin/users/${s.memA.id}`).set(bearer(s.hr.token)).send({ idleWarningSeconds: 60 });
    expect(idle.status).toBe(403);
    expect(idle.body.error).toBe('admin_required_for_idle_warning');
  });

  it('sees every team for the People team picker', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/teams').set(bearer(s.hr.token));
    expect(res.status).toBe(200);
    expect(res.body.teams.map((t: { name: string }) => t.name).sort()).toEqual(['Team A', 'Team H']);
    // A manager still sees only the team they manage.
    const mgr = await request(app).get('/v1/admin/teams').set(bearer(s.mgrA.token));
    expect(mgr.body.teams.map((t: { name: string }) => t.name)).toEqual(['Team A']);
  });

  it('managers and members cannot run People', async () => {
    const s = await seed();
    for (const token of [s.mgrA.token, s.memA.token]) {
      expect((await request(app).patch(`/v1/admin/users/${s.loner.id}`).set(bearer(token)).send({ name: 'X' })).status).toBe(403);
      expect((await request(app).post(`/v1/admin/users/${s.loner.id}/deactivate`).set(bearer(token))).status).toBe(403);
      expect((await request(app).post('/v1/admin/users').set(bearer(token)).send({ email: `m-${Date.now()}@test.local`, name: 'X' })).status).toBe(403);
    }
  });
});

describe('HR without a team: People everywhere, reports like a member', () => {
  it('lists every active person on People, but may change none of their time', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/users').set(bearer(s.hr.token));
    expect(res.status).toBe(200);
    const users = res.body.users as Array<{ id: string; canEdit: boolean; sync: unknown }>;
    expect(users.map((u) => u.id)).toEqual(expect.arrayContaining([s.admin.id, s.memA.id, s.memH.id, s.loner.id, s.hr2.id]));
    for (const u of users) {
      if (u.id === s.hr.id) continue;
      expect(u.canEdit).toBe(false);
      // Sync health is about someone's time — not hers to read.
      expect(u.sync).toBeNull();
    }
  });

  it('approves her own manual time, like a manager', async () => {
    const s = await seed();
    const t = bearer(s.hr.token);
    const res = await request(app).post('/v1/time-requests').set(t).send(manualTime(s.hr.id, 'self'));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPROVED');
    // A member's own request still waits for their approver.
    const mem = await request(app).post('/v1/time-requests').set(bearer(s.loner.token)).send(manualTime(s.loner.id, 'self'));
    expect(mem.body.status).toBe('PENDING');
  });

  it('reads only her own month sheet row', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/reports/month-sheet?month=2026-09').set(bearer(s.hr.token));
    expect(res.status).toBe(200);
    expect((res.body.rows as Array<{ userId: string }>).map((r) => r.userId)).toEqual([s.hr.id]);
  });

  it('cannot open anyone else’s report, screenshots, downloads or team views', async () => {
    const s = await seed();
    const t = bearer(s.hr.token);
    expect((await request(app).get(`/v1/reports/team/member?userId=${s.memA.id}&from=2026-09-01&to=2026-09-30`).set(t)).status).toBe(403);
    expect((await request(app).get(`/v1/reports/team/member/day-screenshots?userId=${s.memA.id}&date=2026-09-10`).set(t)).status).toBe(403);
    expect((await request(app).get(`/v1/insights/day?userId=${s.memA.id}&date=2026-09-10`).set(t)).status).toBe(403);
    expect((await request(app).get('/v1/reports/team/summary?from=2026-09-01&to=2026-09-30').set(t)).status).toBe(403);
    expect((await request(app).get('/v1/reports/month-performance.csv?month=2026-09').set(t)).status).toBe(403);
    expect((await request(app).get('/v1/reports/month-performance.xlsx?month=2026-09').set(t)).status).toBe(403);
    expect((await request(app).get('/v1/admin/timesheets?from=2026-09-01&to=2026-09-14').set(t)).status).toBe(403);
    expect((await request(app).get('/v1/admin/timesheets.csv?from=2026-09-01&to=2026-09-14').set(t)).status).toBe(403);
  });

  it('is refused every write on someone else', async () => {
    const s = await seed();
    const mtr = await pendingRequest(s.memA.id, 9);
    const f = await flag(s.memA.id, 1);
    const t = bearer(s.hr.token);
    expect((await request(app).put('/v1/reports/attendance-override').set(t).send(override(s.memA.id))).status).toBe(403);
    expect((await request(app).delete('/v1/reports/attendance-override').set(t).send({ userId: s.memA.id, date: '2026-09-10', reason: 'x' })).status).toBe(403);
    expect((await request(app).post('/v1/time-requests').set(t).send(manualTime(s.memA.id, 'hr'))).status).toBe(403);
    expect((await request(app).post(`/v1/admin/manual-time-requests/${mtr.id}/decide`).set(t).send({ action: 'approve' })).status).toBe(403);
    expect((await request(app).post(`/v1/admin/flags/${f.id}/resolve`).set(t).send({ resolution: 'DISMISSED' })).status).toBe(403);
    expect((await request(app).patch(`/v1/admin/team-member-settings/${s.memA.id}`).set(t).send({ screenshotIntervalMin: 2 })).status).toBe(403);
    expect((await prisma.manualTimeRequest.findUniqueOrThrow({ where: { id: mtr.id } })).status).toBe('PENDING');
  });

  it('has no approvals queue, flags queue, Team today or team settings', async () => {
    const s = await seed();
    const t = bearer(s.hr.token);
    expect((await request(app).get('/v1/admin/manual-time-requests').set(t)).status).toBe(403);
    expect((await request(app).get('/v1/admin/flags').set(t)).status).toBe(403);
    expect((await request(app).get('/v1/admin/flags/groups').set(t)).status).toBe(403);
    expect((await request(app).get('/v1/admin/overview').set(t)).status).toBe(403);
    expect((await request(app).get('/v1/admin/team-member-settings').set(t)).status).toBe(403);
  });

  it('cannot reach settings, policy, shifts, teams, leave admin or integrations', async () => {
    const s = await seed();
    const t = bearer(s.hr.token);
    expect((await request(app).patch('/v1/admin/workspace-policy').set(t).send({})).status).toBe(403);
    expect((await request(app).patch('/v1/workspace/settings').set(t).send({ timezone: 'UTC' })).status).toBe(403);
    expect((await request(app).post('/v1/admin/shifts').set(t).send({ name: 'S' })).status).toBe(403);
    expect((await request(app).post('/v1/admin/teams').set(t).send({ name: 'T' })).status).toBe(403);
    expect((await request(app).patch(`/v1/admin/teams/${s.teamA.id}`).set(t).send({ name: 'T' })).status).toBe(403);
    expect((await request(app).post(`/v1/admin/teams/${s.teamA.id}/managers`).set(t).send({ userId: s.memA.id })).status).toBe(403);
    expect((await request(app).get('/v1/admin/api-tokens').set(t)).status).toBe(403);
    expect((await request(app).post('/v1/admin/api-tokens').set(t).send({ name: 'x', scopes: [] })).status).toBe(403);
    expect((await request(app).post('/v1/reports/month-pointers/recompute').set(t).send({ month: '2026-09' })).status).toBe(403);
    expect((await request(app).post('/v1/admin/leave/adjust').set(t).send({})).status).toBe(403);
    expect((await request(app).patch(`/v1/admin/leave/members/${s.memA.id}`).set(t).send({ accrualDays: 2 })).status).toBe(403);
    expect((await request(app).post('/v1/admin/leave/holidays').set(t).send({ date: '2026-12-25', name: 'X' })).status).toBe(403);
    expect((await request(app).get('/v1/admin/monitoring-settings-audits').set(t)).status).toBe(403);
  });

  it('a suspended person’s screenshots stay an admin’s', async () => {
    const s = await seed();
    await prisma.user.update({ where: { id: s.memA.id }, data: { deactivatedAt: new Date() } });
    const path = `/v1/reports/team/member/day-screenshots?userId=${s.memA.id}&date=2026-09-10`;
    expect((await request(app).get(path).set(bearer(s.admin.token))).status).toBe(200);
    expect((await request(app).get(path).set(bearer(s.hr.token))).status).toBe(403);
    expect((await request(app).get(path).set(bearer(s.mgrA.token))).status).toBe(403);
  });
});

describe('HR who manages a team is that team’s manager, and no more', () => {
  it('reads her team’s reports and Team today, not anyone else’s', async () => {
    const s = await seed();
    const t = bearer(s.hrLead.token);
    const sheet = await request(app).get('/v1/reports/month-sheet?month=2026-09').set(t);
    expect((sheet.body.rows as Array<{ userId: string }>).map((r) => r.userId).sort()).toEqual([s.hrLead.id, s.memH.id].sort());
    expect((await request(app).get(`/v1/reports/team/member?userId=${s.memH.id}&from=2026-09-01&to=2026-09-30`).set(t)).status).toBe(200);
    expect((await request(app).get(`/v1/reports/team/member?userId=${s.memA.id}&from=2026-09-01&to=2026-09-30`).set(t)).status).toBe(403);
    const overview = await request(app).get('/v1/admin/overview').set(t);
    expect(overview.status).toBe(200);
    expect(overview.body.scope).toBe('team');
    expect((await request(app).get('/v1/reports/month-performance.csv?month=2026-09').set(t)).status).toBe(200);
  });

  it('corrects her team’s attendance, not anyone else’s, not her own', async () => {
    const s = await seed();
    const t = bearer(s.hrLead.token);
    expect((await request(app).put('/v1/reports/attendance-override').set(t).send(override(s.memH.id))).status).toBe(200);
    const other = await request(app).put('/v1/reports/attendance-override').set(t).send(override(s.memA.id));
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('out_of_scope');
    expect((await request(app).put('/v1/reports/attendance-override').set(t).send(override(s.hrLead.id))).status).toBe(403);
  });

  it('sees and decides only her team’s requests', async () => {
    const s = await seed();
    const mine = await pendingRequest(s.memH.id, 9);
    const theirs = await pendingRequest(s.memA.id, 10);
    const t = bearer(s.hrLead.token);
    const list = await request(app).get('/v1/admin/manual-time-requests').set(t);
    expect(list.status).toBe(200);
    expect(list.body.requests.map((r: { id: string }) => r.id)).toEqual([mine.id]);
    expect((await request(app).post(`/v1/admin/manual-time-requests/${theirs.id}/decide`).set(t).send({ action: 'approve' })).status).toBe(403);
    expect((await request(app).post(`/v1/admin/manual-time-requests/${mine.id}/decide`).set(t).send({ action: 'approve' })).status).toBe(200);
  });

  it('sees and resolves only her team’s flags', async () => {
    const s = await seed();
    const mine = await flag(s.memH.id, 1);
    const theirs = await flag(s.memA.id, 2);
    const t = bearer(s.hrLead.token);
    const list = await request(app).get('/v1/admin/flags?status=ALL').set(t);
    expect(list.status).toBe(200);
    expect(list.body.flags.map((f: { id: string }) => f.id)).toEqual([mine.id]);
    expect((await request(app).post(`/v1/admin/flags/${theirs.id}/resolve`).set(t).send({ resolution: 'DISMISSED' })).status).toBe(403);
    expect((await request(app).post(`/v1/admin/flags/${mine.id}/resolve`).set(t).send({ resolution: 'DISMISSED' })).status).toBe(200);
  });

  it('adds time for her team, not for others', async () => {
    const s = await seed();
    const t = bearer(s.hrLead.token);
    expect((await request(app).post('/v1/time-requests').set(t).send(manualTime(s.memH.id, 'lead'))).status).toBe(201);
    expect((await request(app).post('/v1/time-requests').set(t).send(manualTime(s.memA.id, 'lead'))).status).toBe(403);
  });

  it('changes her team’s capture settings, not anyone else’s', async () => {
    const s = await seed();
    const t = bearer(s.hrLead.token);
    const list = await request(app).get('/v1/admin/team-member-settings').set(t);
    expect(list.status).toBe(200);
    expect(list.body.scope).toBe('team');
    const ids = list.body.members.map((m: { id: string }) => m.id);
    expect(ids).toContain(s.memH.id);
    expect(ids).not.toContain(s.memA.id);
    expect((await request(app).patch(`/v1/admin/team-member-settings/${s.memH.id}`).set(t).send({ screenshotIntervalMin: 2 })).status).toBe(200);
    expect((await request(app).patch(`/v1/admin/team-member-settings/${s.memA.id}`).set(t).send({ screenshotIntervalMin: 2 })).status).toBe(404);
  });

  it('the server tells the dashboard whom she may change', async () => {
    const s = await seed();
    const t = bearer(s.hrLead.token);
    const users = await request(app).get('/v1/admin/users').set(t);
    const canEdit = new Map(users.body.users.map((u: { id: string; canEdit: boolean }) => [u.id, u.canEdit]));
    expect(canEdit.get(s.memH.id)).toBe(true);
    expect(canEdit.get(s.memA.id)).toBe(false);
    expect(canEdit.get(s.admin.id)).toBe(false);
    const sheet = await request(app).get('/v1/reports/month-sheet?month=2026-09').set(t);
    const rows = sheet.body.rows as Array<{ userId: string; canEdit: boolean }>;
    expect(rows.find((r) => r.userId === s.memH.id)?.canEdit).toBe(true);
    expect(rows.find((r) => r.userId === s.memA.id)).toBeUndefined();
    const report = await request(app).get(`/v1/reports/team/member?userId=${s.memH.id}&from=2026-09-01&to=2026-09-30`).set(t);
    expect(report.body.canEdit).toBe(true);
    expect(report.body.canCorrect).toBe(true);
  });
});

describe('a manager stays inside their own team', () => {
  it('is refused every write on another team', async () => {
    const s = await seed();
    const mtr = await pendingRequest(s.memH.id, 9);
    const f = await flag(s.memH.id, 1);
    const t = bearer(s.mgrA.token);
    expect((await request(app).put('/v1/reports/attendance-override').set(t).send(override(s.memH.id))).status).toBe(403);
    expect((await request(app).post('/v1/time-requests').set(t).send(manualTime(s.memH.id, 'mgr'))).status).toBe(403);
    expect((await request(app).post(`/v1/admin/manual-time-requests/${mtr.id}/decide`).set(t).send({ action: 'approve' })).status).toBe(403);
    expect((await request(app).post(`/v1/admin/flags/${f.id}/resolve`).set(t).send({ resolution: 'DISMISSED' })).status).toBe(403);
    expect((await request(app).patch(`/v1/admin/team-member-settings/${s.memH.id}`).set(t).send({ screenshotIntervalMin: 2 })).status).toBe(404);
    expect((await request(app).get(`/v1/reports/team/member?userId=${s.memH.id}&from=2026-09-01&to=2026-09-30`).set(t)).status).toBe(403);
  });

  it('still decides and corrects for their own team', async () => {
    const s = await seed();
    const mtr = await pendingRequest(s.memA.id, 9);
    const t = bearer(s.mgrA.token);
    expect((await request(app).put('/v1/reports/attendance-override').set(t).send(override(s.memA.id))).status).toBe(200);
    expect((await request(app).post(`/v1/admin/manual-time-requests/${mtr.id}/decide`).set(t).send({ action: 'approve' })).status).toBe(200);
    expect((await request(app).get('/v1/admin/overview').set(t)).status).toBe(200);
  });
});

describe('a member changes nothing but their own', () => {
  it('is refused every write on anyone else and every team queue', async () => {
    const s = await seed();
    const mtr = await pendingRequest(s.memH.id, 9);
    const f = await flag(s.memH.id, 1);
    const t = bearer(s.memA.token);
    expect((await request(app).put('/v1/reports/attendance-override').set(t).send(override(s.memH.id))).status).toBe(403);
    expect((await request(app).put('/v1/reports/attendance-override').set(t).send(override(s.memA.id))).status).toBe(403);
    expect((await request(app).post('/v1/time-requests').set(t).send(manualTime(s.memH.id, 'mem'))).status).toBe(403);
    expect((await request(app).post(`/v1/admin/manual-time-requests/${mtr.id}/decide`).set(t).send({ action: 'approve' })).status).toBe(403);
    expect((await request(app).post(`/v1/admin/flags/${f.id}/resolve`).set(t).send({ resolution: 'DISMISSED' })).status).toBe(403);
    expect((await request(app).get('/v1/admin/manual-time-requests').set(t)).status).toBe(403);
    expect((await request(app).get('/v1/admin/flags').set(t)).status).toBe(403);
    expect((await request(app).get('/v1/admin/overview').set(t)).status).toBe(403);
    expect((await request(app).get(`/v1/reports/team/member?userId=${s.memH.id}&from=2026-09-01&to=2026-09-30`).set(t)).status).toBe(403);
    expect((await request(app).get('/v1/reports/month-performance.csv?month=2026-09').set(t)).status).toBe(403);
  });
});
