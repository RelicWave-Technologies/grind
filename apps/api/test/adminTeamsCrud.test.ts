import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { NINE_TO_SIX } from '@grind/types';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { createManagedTeam } from './helpers';

/**
 * /v1/admin/teams + /v1/admin/users/:id (PATCH) — ADMIN-only CRUD against
 * real Postgres. Covers happy paths, scope (cross-workspace 404s), validation,
 * and the "never demote the last ADMIN" safety net.
 */

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS-crud-${stamp}` } });
  const ws2 = await prisma.workspace.create({ data: { name: `WS-other-${stamp}` } });
  const mk = (workspaceId: string, email: string, name: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: {
        workspaceId,
        email: `${email}-${stamp}@test.local`,
        name,
        role,
        provisioningStatus: 'ACTIVE',
        passwordHash: 'x'.repeat(60),
      },
    });
  const admin = await mk(ws.id, 'admin', 'Alice Admin', 'ADMIN');
  const mgr = await mk(ws.id, 'mgr', 'Mira Manager', 'MANAGER');
  const mem1 = await mk(ws.id, 'm1', 'Mia Member', 'MEMBER');
  const mem2 = await mk(ws.id, 'm2', 'Max Member', 'MEMBER');
  // Bystander in another workspace; we should never see them.
  const bystander = await mk(ws2.id, 'bys', 'Bob Bystander', 'MEMBER');

  const tok = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }, wsId = ws.id) =>
    signAccessToken({ sub: u.id, ws: wsId, role: u.role });

  return {
    ws,
    ws2,
    admin: { id: admin.id, token: tok(admin) },
    mgr: { id: mgr.id, token: tok(mgr) },
    mem1: { id: mem1.id, token: tok(mem1) },
    mem2: { id: mem2.id, token: tok(mem2) },
    bystander: { id: bystander.id, token: tok(bystander, ws2.id) },
  };
}

describe('/v1/admin/teams — list + create', () => {
  it('MEMBER → 403', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/teams').set(auth(s.mem1.token));
    expect(res.status).toBe(403);
  });

  it('ADMIN sees all workspace teams; MANAGER sees only theirs', async () => {
    const s = await seed();
    const t1 = await createManagedTeam({ workspaceId: s.ws.id, name: 'Squad A', managerId: s.mgr.id });
    const t2 = await createManagedTeam({ workspaceId: s.ws.id, name: 'Squad B', managerId: s.admin.id });

    const adminRes = await request(app).get('/v1/admin/teams').set(auth(s.admin.token));
    expect(adminRes.status).toBe(200);
    const adminIds = adminRes.body.teams.map((t: { id: string }) => t.id);
    expect(adminIds).toContain(t1.id);
    expect(adminIds).toContain(t2.id);

    const mgrRes = await request(app).get('/v1/admin/teams').set(auth(s.mgr.token));
    expect(mgrRes.status).toBe(200);
    expect(mgrRes.body.teams.map((t: { id: string }) => t.id)).toEqual([t1.id]);
  });

  it('POST creates a team and moves a non-admin manager into that team', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/admin/teams')
      .set(auth(s.admin.token))
      .send({ name: 'Fresh Squad', managerId: s.mgr.id });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Fresh Squad');
    expect(res.body.managerId).toBe(s.mgr.id);
    expect(res.body.managerIds).toEqual([s.mgr.id]);
    expect(res.body.memberCount).toBe(1);
    const reload = await prisma.user.findUnique({ where: { id: s.mgr.id }, select: { role: true, teamId: true } });
    expect(reload).toMatchObject({ role: 'MANAGER', teamId: res.body.id });
  });

  it('POST with an admin manager does not force the admin into the team', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/admin/teams')
      .set(auth(s.admin.token))
      .send({ name: 'Admin Managed', managerId: s.admin.id });
    expect(res.status).toBe(201);
    expect(res.body.managerIds).toEqual([s.admin.id]);
    expect(res.body.memberCount).toBe(0);
    const reload = await prisma.user.findUnique({ where: { id: s.admin.id }, select: { role: true, teamId: true } });
    expect(reload).toMatchObject({ role: 'ADMIN', teamId: null });
  });

  it('POST rejects empty name', async () => {
    const s = await seed();
    const res = await request(app).post('/v1/admin/teams').set(auth(s.admin.token)).send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST can create an empty team before managers are assigned', async () => {
    const s = await seed();
    const res = await request(app).post('/v1/admin/teams').set(auth(s.admin.token)).send({ name: 'No Manager' });
    expect(res.status).toBe(201);
    expect(res.body.managerIds).toEqual([]);
  });

  it('POST rejects a manager from another workspace', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/admin/teams')
      .set(auth(s.admin.token))
      .send({ name: 'X', managerId: s.bystander.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('manager_unavailable');
  });

  it('POST rejects a manager who already owns another team', async () => {
    const s = await seed();
    const existing = await createManagedTeam({ workspaceId: s.ws.id, name: 'Already Managed', managerId: s.mgr.id });

    const res = await request(app)
      .post('/v1/admin/teams')
      .set(auth(s.admin.token))
      .send({ name: 'Second Team', managerId: s.mgr.id });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'manager_already_assigned',
      teamId: existing.id,
      teamName: existing.name,
    });
  });

  it('MANAGER cannot POST (admin-only write)', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/admin/teams')
      .set(auth(s.mgr.token))
      .send({ name: 'Sneaky', managerId: s.mgr.id });
    expect(res.status).toBe(403);
  });
});

describe('/v1/admin/teams/:id — patch + delete', () => {
  it('rename works', async () => {
    const s = await seed();
    const t = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Old' } });
    const res = await request(app)
      .patch(`/v1/admin/teams/${t.id}`)
      .set(auth(s.admin.token))
      .send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
  });

  it('replaces managers through the compatibility managerId patch and can clear managers', async () => {
    const s = await seed();
    const t = await createManagedTeam({ workspaceId: s.ws.id, name: 'X', managerId: s.mgr.id });
    const r1 = await request(app)
      .patch(`/v1/admin/teams/${t.id}`)
      .set(auth(s.admin.token))
      .send({ managerId: s.admin.id });
    expect(r1.status).toBe(200);
    expect(r1.body.managerId).toBe(s.admin.id);
    expect(r1.body.managerIds).toEqual([s.admin.id]);
    const r2 = await request(app)
      .patch(`/v1/admin/teams/${t.id}`)
      .set(auth(s.admin.token))
      .send({ managerId: null });
    expect(r2.status).toBe(200);
    expect(r2.body.managerIds).toEqual([]);
  });

  it('rejects reassigning a manager who already owns another team', async () => {
    const s = await seed();
    const existing = await createManagedTeam({ workspaceId: s.ws.id, name: 'Managed One', managerId: s.mgr.id });
    const target = await createManagedTeam({ workspaceId: s.ws.id, name: 'Managed Two', managerId: s.admin.id });

    const res = await request(app)
      .patch(`/v1/admin/teams/${target.id}`)
      .set(auth(s.admin.token))
      .send({ managerId: s.mgr.id });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'manager_already_assigned',
      teamId: existing.id,
      teamName: existing.name,
    });
  });

  it('cross-workspace team → 404', async () => {
    const s = await seed();
    const t = await prisma.team.create({ data: { workspaceId: s.ws2.id, name: 'Other-ws' } });
    const res = await request(app)
      .patch(`/v1/admin/teams/${t.id}`)
      .set(auth(s.admin.token))
      .send({ name: 'No' });
    expect(res.status).toBe(404);
  });

  it('DELETE drops team; members keep their User row, teamId → null', async () => {
    const s = await seed();
    const t = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Doomed' } });
    await prisma.user.update({ where: { id: s.mem1.id }, data: { teamId: t.id } });
    const res = await request(app).delete(`/v1/admin/teams/${t.id}`).set(auth(s.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const reload = await prisma.user.findUnique({ where: { id: s.mem1.id } });
    expect(reload?.teamId).toBeNull();
  });

  it('supports multiple managers on one team and derives non-admin manager roles', async () => {
    const s = await seed();
    const t = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Multi Managed' } });

    const first = await request(app)
      .post(`/v1/admin/teams/${t.id}/managers`)
      .set(auth(s.admin.token))
      .send({ userId: s.mem1.id });
    expect(first.status).toBe(201);
    expect(first.body.managerIds).toEqual([s.mem1.id]);

    const second = await request(app)
      .post(`/v1/admin/teams/${t.id}/managers`)
      .set(auth(s.admin.token))
      .send({ userId: s.mem2.id });
    expect(second.status).toBe(201);
    expect(new Set(second.body.managerIds)).toEqual(new Set([s.mem1.id, s.mem2.id]));

    const users = await prisma.user.findMany({
      where: { id: { in: [s.mem1.id, s.mem2.id] } },
      select: { id: true, role: true, teamId: true },
    });
    expect(new Map(users.map((u) => [u.id, { role: u.role, teamId: u.teamId }]))).toEqual(new Map([
      [s.mem1.id, { role: 'MANAGER', teamId: t.id }],
      [s.mem2.id, { role: 'MANAGER', teamId: t.id }],
    ]));
  });

  it('adding a member from another team as manager moves them into the managed team', async () => {
    const s = await seed();
    const source = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Source Team' } });
    const target = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Target Team' } });
    await prisma.user.update({ where: { id: s.mem1.id }, data: { teamId: source.id } });

    const res = await request(app)
      .post(`/v1/admin/teams/${target.id}/managers`)
      .set(auth(s.admin.token))
      .send({ userId: s.mem1.id });

    expect(res.status).toBe(201);
    expect(res.body.managerIds).toEqual([s.mem1.id]);
    const reload = await prisma.user.findUnique({ where: { id: s.mem1.id }, select: { role: true, teamId: true } });
    expect(reload).toMatchObject({ role: 'MANAGER', teamId: target.id });
  });

  it('removing a user from their only managed team downgrades them to MEMBER but keeps their home team', async () => {
    const s = await seed();
    const t = await createManagedTeam({ workspaceId: s.ws.id, name: 'Managed', managerId: s.mem1.id });

    const res = await request(app).delete(`/v1/admin/teams/${t.id}/managers/${s.mem1.id}`).set(auth(s.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.managerIds).toEqual([]);

    const reload = await prisma.user.findUnique({ where: { id: s.mem1.id }, select: { role: true, teamId: true } });
    expect(reload).toMatchObject({ role: 'MEMBER', teamId: t.id });
  });

  it('deleting a team clears former non-admin manager teamId and downgrades role', async () => {
    const s = await seed();
    const t = await createManagedTeam({ workspaceId: s.ws.id, name: 'Temporary Managed', managerId: s.mem1.id });

    const res = await request(app).delete(`/v1/admin/teams/${t.id}`).set(auth(s.admin.token));
    expect(res.status).toBe(200);

    const reload = await prisma.user.findUnique({ where: { id: s.mem1.id }, select: { role: true, teamId: true } });
    expect(reload).toMatchObject({ role: 'MEMBER', teamId: null });
  });
});

describe('PATCH /v1/admin/users/:id', () => {
  it('MEMBER cannot patch', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.mem1.token))
      .send({ name: 'Hax' });
    expect(res.status).toBe(403);
  });

  it('MANAGER cannot patch users', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.mgr.token))
      .send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('ADMIN can change name + teamId in one call', async () => {
    const s = await seed();
    const t = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Target' } });
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.admin.token))
      .send({ name: 'Mia Member', teamId: t.id });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Mia Member');
    expect(res.body.role).toBe('MEMBER');
    expect(res.body.teamId).toBe(t.id);
  });

  it('rejects moving a non-admin manager away from their managed team', async () => {
    const s = await seed();
    const managed = await createManagedTeam({ workspaceId: s.ws.id, name: 'Managed A', managerId: s.mgr.id });
    const other = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Other Team' } });

    const move = await request(app)
      .patch(`/v1/admin/users/${s.mgr.id}`)
      .set(auth(s.admin.token))
      .send({ teamId: other.id });
    expect(move.status).toBe(409);
    expect(move.body).toMatchObject({
      error: 'managed_user_team_locked',
      managedTeamId: managed.id,
      managedTeamName: managed.name,
    });

    const clear = await request(app)
      .patch(`/v1/admin/users/${s.mgr.id}`)
      .set(auth(s.admin.token))
      .send({ teamId: null });
    expect(clear.status).toBe(409);
    expect(clear.body.error).toBe('managed_user_team_locked');
  });

  it('rejects adding a manager of one team as a member of another team', async () => {
    const s = await seed();
    const managed = await createManagedTeam({ workspaceId: s.ws.id, name: 'Managed A', managerId: s.mgr.id });
    const other = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Other Team' } });

    const res = await request(app)
      .patch(`/v1/admin/users/${s.mgr.id}`)
      .set(auth(s.admin.token))
      .send({ teamId: other.id });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'managed_user_team_locked',
      managedTeamId: managed.id,
    });
  });

  it('rejects direct MANAGER role writes because manager role is derived from team assignment', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.admin.token))
      .send({ role: 'MANAGER' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('manager_role_is_derived');
  });

  it('ADMIN can change activityRoleTitle for scoring', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.admin.token))
      .send({ activityRoleTitle: 'DESIGNER' });
    expect(res.status).toBe(200);
    expect(res.body.activityRoleTitle).toBe('DESIGNER');
    const reload = await prisma.user.findUnique({ where: { id: s.mem1.id } });
    expect(reload?.activityRoleTitle).toBe('DESIGNER');
  });

  it('ADMIN cannot move a user to a team in another workspace', async () => {
    const s = await seed();
    const otherTeam = await prisma.team.create({ data: { workspaceId: s.ws2.id, name: 'Other' } });
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.admin.token))
      .send({ teamId: otherTeam.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('team_out_of_workspace');
  });

  it('rejects invalid role string', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.admin.token))
      .send({ role: 'SUPERHERO' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid activityRoleTitle string', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.admin.token))
      .send({ activityRoleTitle: 'WIZARD' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_activity_role_title');
  });

  it('rejects non-null direct managerId writes because managerId is deprecated', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.admin.token))
      .send({ managerId: s.mem1.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('manager_id_deprecated');
  });

  it('protects the last ADMIN from being demoted', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/users/${s.admin.id}`)
      .set(auth(s.admin.token))
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('last_admin_protected');
  });

  it('allows demoting an ADMIN when a second active ADMIN exists', async () => {
    const s = await seed();
    await prisma.user.create({
      data: {
        workspaceId: s.ws.id,
        email: `admin2-${Date.now()}@test.local`,
        name: 'Ava Admin',
        role: 'ADMIN',
        passwordHash: 'x'.repeat(60),
      },
    });
    const res = await request(app)
      .patch(`/v1/admin/users/${s.admin.id}`)
      .set(auth(s.admin.token))
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('MEMBER');
  });

  it('cross-workspace target → 404', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/users/${s.bystander.id}`)
      .set(auth(s.admin.token))
      .send({ name: 'No' });
    expect(res.status).toBe(404);
  });
});

describe('/v1/admin/team-member-settings', () => {
  it('lets an admin complete setup from team settings and activate a pending member', async () => {
    const s = await seed();
    const team = await createManagedTeam({ workspaceId: s.ws.id, name: 'Managed Team', managerId: s.mgr.id });
    await prisma.user.update({
      where: { id: s.mem1.id },
      data: { teamId: team.id, managerId: null, provisioningStatus: 'PENDING' },
    });
    const shift = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'Day', schedule: NINE_TO_SIX, bufferMin: 20 },
    });

    const patch = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.mem1.id}`)
      .set(auth(s.admin.token))
      .send({ shiftId: shift.id });
    expect(patch.status).toBe(200);
    expect(patch.body.shiftId).toBe(shift.id);

    const reload = await prisma.user.findUnique({
      where: { id: s.mem1.id },
      select: { provisioningStatus: true, shiftId: true },
    });
    expect(reload).toMatchObject({ provisioningStatus: 'ACTIVE', shiftId: shift.id });
  });

  it('lets a manager configure their team member without gaining full People edit rights', async () => {
    const s = await seed();
    const team = await createManagedTeam({ workspaceId: s.ws.id, name: 'Managed Team', managerId: s.mgr.id });
    await prisma.user.update({
      where: { id: s.mem1.id },
      data: { teamId: team.id },
    });
    const shift = await prisma.shift.create({
      data: {
        workspaceId: s.ws.id,
        name: 'Day',
        schedule: {
          mon: { start: '09:00', end: '18:00' },
          tue: { start: '09:00', end: '18:00' },
          wed: { start: '09:00', end: '18:00' },
          thu: { start: '09:00', end: '18:00' },
          fri: { start: '09:00', end: '18:00' },
          sat: null,
          sun: null,
        },
        bufferMin: 20,
      },
    });

    const list = await request(app).get('/v1/admin/team-member-settings').set(auth(s.mgr.token));
    expect(list.status).toBe(200);
    expect(list.body.scope).toBe('team');
    const listedIds = list.body.members.map((m: { id: string }) => m.id);
    expect(listedIds).toContain(s.mgr.id);
    expect(listedIds).toContain(s.mem1.id);
    const managedMember = list.body.members.find((m: { id: string }) => m.id === s.mem1.id);
    expect(managedMember.manager.id).toBe(s.mgr.id);
    expect(list.body.shifts.map((sh: { id: string }) => sh.id)).toContain(shift.id);

    const patch = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.mem1.id}`)
      .set(auth(s.mgr.token))
      .send({ shiftId: shift.id, screenshotIntervalMin: 3, idleThresholdMin: 10 });
    expect(patch.status).toBe(200);
    expect(patch.body.shiftId).toBe(shift.id);
    expect(patch.body.screenshotIntervalMin).toBe(3);
    expect(patch.body.idleThresholdMin).toBe(10);

    const reload = await prisma.user.findUnique({ where: { id: s.mem1.id } });
    expect(reload?.shiftId).toBe(shift.id);
    expect(reload?.screenshotIntervalMin).toBe(3);
    expect(reload?.idleThresholdMin).toBe(10);

    const assignment = await prisma.shiftAssignment.findFirst({
      where: { userId: s.mem1.id, effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
    });
    expect(assignment?.shiftId).toBe(shift.id);
    expect(assignment?.shiftNameSnapshot).toBe('Day');
    expect(assignment?.bufferMinSnapshot).toBe(20);

    const selfPatch = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.mgr.id}`)
      .set(auth(s.mgr.token))
      .send({ screenshotIntervalMin: 3, idleThresholdMin: 15 });
    expect(selfPatch.status).toBe(403);
    expect(selfPatch.body.error).toBe('self_settings_forbidden');

    const adminPatch = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.mgr.id}`)
      .set(auth(s.admin.token))
      .send({ screenshotIntervalMin: 3, idleThresholdMin: 15 });
    expect(adminPatch.status).toBe(200);
    expect(adminPatch.body.id).toBe(s.mgr.id);
    expect(adminPatch.body.screenshotIntervalMin).toBe(3);
    expect(adminPatch.body.idleThresholdMin).toBe(15);
  });

  it('requires an audit reason before changing member timing to 1 minute', async () => {
    const s = await seed();
    const team = await createManagedTeam({ workspaceId: s.ws.id, name: 'Managed Team', managerId: s.mgr.id });
    await prisma.user.update({
      where: { id: s.mem1.id },
      data: { teamId: team.id, managerId: null },
    });

    const denied = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.mem1.id}`)
      .set(auth(s.mgr.token))
      .send({ screenshotIntervalMin: 1 });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toBe('missing_monitoring_audit_reason');
    expect(await prisma.monitoringSettingsAudit.findMany({ where: { workspaceId: s.ws.id } })).toHaveLength(0);

    const allowed = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.mem1.id}`)
      .set(auth(s.mgr.token))
      .send({ screenshotIntervalMin: 1, auditReason: 'Temporary high-touch review approved by admin.' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.screenshotIntervalMin).toBe(1);

    const audit = await prisma.monitoringSettingsAudit.findFirstOrThrow({
      where: { workspaceId: s.ws.id },
    });
    expect(audit).toMatchObject({
      actorId: s.mgr.id,
      targetUserId: s.mem1.id,
      scope: 'MEMBER_OVERRIDE',
      previousScreenshotIntervalMin: 3,
      previousIdleThresholdMin: 5,
      nextScreenshotIntervalMin: 1,
      nextIdleThresholdMin: 5,
      riskLevel: 'HIGH',
      reason: 'Temporary high-touch review approved by admin.',
    });
  });

  it('audits caution member timing changes without requiring a reason', async () => {
    const s = await seed();
    const team = await createManagedTeam({ workspaceId: s.ws.id, name: 'Managed Team', managerId: s.mgr.id });
    await prisma.user.update({
      where: { id: s.mem1.id },
      data: { teamId: team.id, managerId: null },
    });

    const res = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.mem1.id}`)
      .set(auth(s.mgr.token))
      .send({ idleThresholdMin: 3 });
    expect(res.status).toBe(200);
    expect(res.body.idleThresholdMin).toBe(3);

    const audit = await prisma.monitoringSettingsAudit.findFirstOrThrow({
      where: { workspaceId: s.ws.id },
    });
    expect(audit).toMatchObject({
      actorId: s.mgr.id,
      targetUserId: s.mem1.id,
      scope: 'MEMBER_OVERRIDE',
      previousScreenshotIntervalMin: 3,
      previousIdleThresholdMin: 5,
      nextScreenshotIntervalMin: 3,
      nextIdleThresholdMin: 3,
      riskLevel: 'CAUTION',
      reason: null,
    });
  });

  it('keeps manager settings writes scoped to their team', async () => {
    const s = await seed();
    const team = await createManagedTeam({ workspaceId: s.ws.id, name: 'Managed Team', managerId: s.mgr.id });
    await prisma.user.update({
      where: { id: s.mem1.id },
      data: { teamId: team.id, managerId: null },
    });

    const outsider = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.mem2.id}`)
      .set(auth(s.mgr.token))
      .send({ idleThresholdMin: 15 });
    expect(outsider.status).toBe(404);

    const member = await request(app).get('/v1/admin/team-member-settings').set(auth(s.mem1.token));
    expect(member.status).toBe(403);
  });
});
