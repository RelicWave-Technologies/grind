import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

/**
 * /v1/admin/teams + /v1/admin/users/:id (PATCH) — ADMIN-only CRUD against
 * real Postgres. Covers happy paths, scope (cross-workspace 404s), validation,
 * and the "never demote the last OWNER" safety net.
 */

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS-crud-${stamp}` } });
  const ws2 = await prisma.workspace.create({ data: { name: `WS-other-${stamp}` } });
  const mk = (workspaceId: string, email: string, name: string, role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: { workspaceId, email: `${email}-${stamp}@test.local`, name, role, passwordHash: 'x'.repeat(60) },
    });
  const owner = await mk(ws.id, 'owner', 'Olivia Owner', 'OWNER');
  const admin = await mk(ws.id, 'admin', 'Alice Admin', 'ADMIN');
  const mgr = await mk(ws.id, 'mgr', 'Mira Manager', 'MANAGER');
  const mem1 = await mk(ws.id, 'm1', 'Mia Member', 'MEMBER');
  const mem2 = await mk(ws.id, 'm2', 'Max Member', 'MEMBER');
  // Bystander in another workspace; we should never see them.
  const bystander = await mk(ws2.id, 'bys', 'Bob Bystander', 'MEMBER');

  const tok = (u: { id: string; role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' }, wsId = ws.id) =>
    signAccessToken({ sub: u.id, ws: wsId, role: u.role });

  return {
    ws,
    ws2,
    owner: { id: owner.id, token: tok(owner) },
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
    const t1 = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Squad A', managerId: s.mgr.id } });
    const t2 = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Squad B', managerId: s.admin.id } });

    const adminRes = await request(app).get('/v1/admin/teams').set(auth(s.admin.token));
    expect(adminRes.status).toBe(200);
    const adminIds = adminRes.body.teams.map((t: { id: string }) => t.id);
    expect(adminIds).toContain(t1.id);
    expect(adminIds).toContain(t2.id);

    const mgrRes = await request(app).get('/v1/admin/teams').set(auth(s.mgr.token));
    expect(mgrRes.status).toBe(200);
    expect(mgrRes.body.teams.map((t: { id: string }) => t.id)).toEqual([t1.id]);
  });

  it('POST creates a team; memberCount starts at 0', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/admin/teams')
      .set(auth(s.admin.token))
      .send({ name: 'Fresh Squad', managerId: s.mgr.id });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Fresh Squad');
    expect(res.body.managerId).toBe(s.mgr.id);
    expect(res.body.memberCount).toBe(0);
  });

  it('POST rejects empty name', async () => {
    const s = await seed();
    const res = await request(app).post('/v1/admin/teams').set(auth(s.admin.token)).send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST rejects a manager from another workspace', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/admin/teams')
      .set(auth(s.admin.token))
      .send({ name: 'X', managerId: s.bystander.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('manager_out_of_workspace');
  });

  it('MANAGER cannot POST (admin-only write)', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/admin/teams')
      .set(auth(s.mgr.token))
      .send({ name: 'Sneaky' });
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

  it('reassign managerId works; sending null clears it', async () => {
    const s = await seed();
    const t = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'X', managerId: s.mgr.id } });
    const r1 = await request(app)
      .patch(`/v1/admin/teams/${t.id}`)
      .set(auth(s.admin.token))
      .send({ managerId: s.admin.id });
    expect(r1.status).toBe(200);
    expect(r1.body.managerId).toBe(s.admin.id);
    const r2 = await request(app)
      .patch(`/v1/admin/teams/${t.id}`)
      .set(auth(s.admin.token))
      .send({ managerId: null });
    expect(r2.status).toBe(200);
    expect(r2.body.managerId).toBeNull();
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

  it('ADMIN can change name + role + teamId in one call', async () => {
    const s = await seed();
    const t = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Target' } });
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.admin.token))
      .send({ name: 'Mia Promoted', role: 'MANAGER', teamId: t.id });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Mia Promoted');
    expect(res.body.role).toBe('MANAGER');
    expect(res.body.teamId).toBe(t.id);
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

  it('rejects setting self as own manager', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/users/${s.mem1.id}`)
      .set(auth(s.admin.token))
      .send({ managerId: s.mem1.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot_manage_self');
  });

  it('protects the last OWNER from being demoted', async () => {
    const s = await seed();
    // The seed creates ONE OWNER (olivia). Demoting them should fail.
    const res = await request(app)
      .patch(`/v1/admin/users/${s.owner.id}`)
      .set(auth(s.admin.token))
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('last_owner_protected');
  });

  it('allows demoting an OWNER when a second OWNER exists', async () => {
    const s = await seed();
    // Promote admin to OWNER first.
    await prisma.user.update({ where: { id: s.admin.id }, data: { role: 'OWNER' } });
    const res = await request(app)
      .patch(`/v1/admin/users/${s.owner.id}`)
      .set(auth(s.admin.token))
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('ADMIN');
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
