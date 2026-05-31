import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { hashPassword } from '../src/lib/password';

/**
 * /v1/admin/users + scope-resolution tests against real Postgres.
 *
 * Builds a workspace with 1 admin, 1 manager, 2 members of that manager's
 * team, and 1 member outside the team, then verifies each role gets the
 * expected user list:
 *   MEMBER     → 1 (self)
 *   MANAGER    → 3 (manager + 2 team members)
 *   ADMIN/OWNER → 5 (everyone in the workspace)
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seedWorkspace() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS ${stamp}` } });
  const mk = (email: string, name: string, role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER') =>
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
  const manager = await mk('mgr', 'Mira Manager', 'MANAGER');
  const member1 = await mk('m1', 'Mia Member', 'MEMBER');
  const member2 = await mk('m2', 'Max Member', 'MEMBER');
  const outsider = await mk('out', 'Owen Outsider', 'MEMBER');

  // Build the team: manager + member1 + member2.
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Squad A', managerId: manager.id } });
  await prisma.user.updateMany({ where: { id: { in: [manager.id, member1.id, member2.id] } }, data: { teamId: team.id } });

  const token = (u: { id: string; role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });

  return {
    ws,
    admin: { id: admin.id, token: token(admin) },
    manager: { id: manager.id, token: token(manager) },
    member1: { id: member1.id, token: token(member1) },
    member2: { id: member2.id, token: token(member2) },
    outsider: { id: outsider.id, token: token(outsider) },
  };
}

describe('GET /v1/admin/users — role-scoped list', () => {
  it('MEMBER → returns only self with scope=self', async () => {
    const w = await seedWorkspace();
    const res = await request(app).get('/v1/admin/users').set(bearer(w.member1.token));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('self');
    expect(res.body.users.map((u: { id: string }) => u.id)).toEqual([w.member1.id]);
  });

  it('MEMBER outside any team → still sees only self', async () => {
    const w = await seedWorkspace();
    const res = await request(app).get('/v1/admin/users').set(bearer(w.outsider.token));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('self');
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].id).toBe(w.outsider.id);
  });

  it('MANAGER → returns the team (self + 2 members), scope=team, does NOT include the outsider', async () => {
    const w = await seedWorkspace();
    const res = await request(app).get('/v1/admin/users').set(bearer(w.manager.token));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('team');
    const ids = new Set(res.body.users.map((u: { id: string }) => u.id));
    expect(ids.size).toBe(3);
    expect(ids.has(w.manager.id)).toBe(true);
    expect(ids.has(w.member1.id)).toBe(true);
    expect(ids.has(w.member2.id)).toBe(true);
    expect(ids.has(w.outsider.id)).toBe(false);
    expect(ids.has(w.admin.id)).toBe(false);
  });

  it('ADMIN → returns every user in the workspace, scope=workspace', async () => {
    const w = await seedWorkspace();
    const res = await request(app).get('/v1/admin/users').set(bearer(w.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('workspace');
    const ids = new Set(res.body.users.map((u: { id: string }) => u.id));
    expect(ids.size).toBe(5);
    expect(ids.has(w.outsider.id)).toBe(true);
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/v1/admin/users');
    expect(res.status).toBe(401);
  });

  it('MANAGER scope does not leak users from another team in the same workspace', async () => {
    const w = await seedWorkspace();
    // Add a second team in the same workspace, with a different manager + 2 members,
    // and verify our first manager doesn't see any of them.
    const mgr2 = await prisma.user.create({
      data: {
        workspaceId: w.ws.id,
        email: `mgr2-${Date.now()}-${counter}@test.local`,
        name: 'Other Manager',
        role: 'MANAGER',
        passwordHash: 'x'.repeat(60),
      },
    });
    const t2 = await prisma.team.create({ data: { workspaceId: w.ws.id, name: 'Squad B', managerId: mgr2.id } });
    const m3 = await prisma.user.create({
      data: {
        workspaceId: w.ws.id,
        email: `m3-${Date.now()}-${counter}@test.local`,
        name: 'Cross Member',
        role: 'MEMBER',
        teamId: t2.id,
        passwordHash: 'x'.repeat(60),
      },
    });
    const res = await request(app).get('/v1/admin/users').set(bearer(w.manager.token));
    expect(res.status).toBe(200);
    const ids = new Set(res.body.users.map((u: { id: string }) => u.id));
    expect(ids.has(mgr2.id)).toBe(false);
    expect(ids.has(m3.id)).toBe(false);
  });
});

// Pass through the unused variable references so an eager unused-var lint
// doesn't fail in dev.
void hashPassword;
