import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { hashPassword } from '../src/lib/password';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-inv`;
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
  const member = await mk('mem', 'MEMBER');
  const token = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });
  return {
    ws,
    stamp,
    admin: { id: admin.id, token: token(admin) },
    mgr: { id: mgr.id, token: token(mgr) },
    member: { id: member.id, token: token(member) },
  };
}

describe('POST /v1/admin/users (invite)', () => {
  it('rejects MEMBER', async () => {
    const { member } = await seed();
    const res = await request(app)
      .post('/v1/admin/users')
      .set(bearer(member.token))
      .send({ email: 'new@x.com', name: 'New' });
    expect(res.status).toBe(403);
  });

  it('rejects MANAGER (admin-only)', async () => {
    const { mgr } = await seed();
    const res = await request(app)
      .post('/v1/admin/users')
      .set(bearer(mgr.token))
      .send({ email: 'new@x.com', name: 'New' });
    expect(res.status).toBe(403);
  });

  it('400 invalid_email', async () => {
    const { admin } = await seed();
    const res = await request(app)
      .post('/v1/admin/users')
      .set(bearer(admin.token))
      .send({ email: 'not-an-email', name: 'N' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_email');
  });

  it('400 invalid_name (empty)', async () => {
    const { admin } = await seed();
    const res = await request(app)
      .post('/v1/admin/users')
      .set(bearer(admin.token))
      .send({ email: 'new@x.com', name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_name');
  });

  it('400 invalid_role for unknown roles', async () => {
    const { admin } = await seed();
    const res = await request(app)
      .post('/v1/admin/users')
      .set(bearer(admin.token))
      .send({ email: 'superadmin@x.com', name: 'Super Admin', role: 'SUPERADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_role');
  });

  it('creates a MEMBER + lands in the caller\'s workspace', async () => {
    const { ws, admin, stamp } = await seed();
    const res = await request(app)
      .post('/v1/admin/users')
      .set(bearer(admin.token))
      .send({ email: `pat-${stamp}@x.com`, name: 'Pat New' });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(`pat-${stamp}@x.com`);
    expect(res.body.role).toBe('MEMBER');
    const created = await prisma.user.findUnique({ where: { id: res.body.id } });
    expect(created?.workspaceId).toBe(ws.id);
    expect(created?.deactivatedAt).toBeNull();
  });

  it('applies workspace policy defaults to newly-created members', async () => {
    const { ws, admin, stamp } = await seed();
    await prisma.workspacePolicy.create({
      data: {
        workspaceId: ws.id,
        defaultScreenshotIntervalMin: 60,
        defaultIdleThresholdMin: 10,
      },
    });

    const res = await request(app)
      .post('/v1/admin/users')
      .set(bearer(admin.token))
      .send({ email: `policy-${stamp}@x.com`, name: 'Policy New' });

    expect(res.status).toBe(201);
    const created = await prisma.user.findUnique({ where: { id: res.body.id } });
    expect(created?.screenshotIntervalMin).toBe(60);
    expect(created?.idleThresholdMin).toBe(10);
  });

  it('409 on duplicate email', async () => {
    const { admin, stamp } = await seed();
    await prisma.user.create({
      data: {
        workspaceId: (await seed()).ws.id, // any other workspace
        email: `dupe-${stamp}@x.com`,
        name: 'Dupe',
        role: 'MEMBER',
        passwordHash: 'x'.repeat(60),
      },
    });
    const res = await request(app)
      .post('/v1/admin/users')
      .set(bearer(admin.token))
      .send({ email: `dupe-${stamp}@x.com`, name: 'Pat' });
    expect(res.status).toBe(409);
  });

  it('normalizes email to lowercase + trim', async () => {
    const { admin, stamp } = await seed();
    const res = await request(app)
      .post('/v1/admin/users')
      .set(bearer(admin.token))
      .send({ email: `  CAPS-${stamp}@X.COM  `, name: 'C' });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(`caps-${stamp}@x.com`);
  });
});

describe('POST /v1/admin/users/:id/deactivate + /reactivate', () => {
  it('rejects MEMBER for deactivate', async () => {
    const { member } = await seed();
    const res = await request(app)
      .post(`/v1/admin/users/${member.id}/deactivate`)
      .set(bearer(member.token));
    expect(res.status).toBe(403);
  });

  it('deactivates a MEMBER + sets deactivatedAt', async () => {
    const { admin, member } = await seed();
    const res = await request(app)
      .post(`/v1/admin/users/${member.id}/deactivate`)
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.deactivatedAt).toBeTruthy();
    const row = await prisma.user.findUnique({ where: { id: member.id } });
    expect(row?.deactivatedAt).not.toBeNull();
  });

  it('409 on already-deactivated', async () => {
    const { admin, member } = await seed();
    await prisma.user.update({ where: { id: member.id }, data: { deactivatedAt: new Date() } });
    const res = await request(app)
      .post(`/v1/admin/users/${member.id}/deactivate`)
      .set(bearer(admin.token));
    expect(res.status).toBe(409);
  });

  it('cannot deactivate the last active ADMIN', async () => {
    const { admin } = await seed();
    const res = await request(app)
      .post(`/v1/admin/users/${admin.id}/deactivate`)
      .set(bearer(admin.token));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('last_admin_protected');
  });

  it('can deactivate an ADMIN when another active ADMIN exists', async () => {
    const { admin, ws, stamp } = await seed();
    const admin2 = await prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `admin2-${stamp}@x.com`,
        name: 'A2',
        role: 'ADMIN',
        passwordHash: 'x'.repeat(60),
      },
    });
    const res = await request(app)
      .post(`/v1/admin/users/${admin.id}/deactivate`)
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(admin2.id).toBeTruthy();
  });

  it('reactivate clears deactivatedAt', async () => {
    const { admin, member } = await seed();
    await prisma.user.update({ where: { id: member.id }, data: { deactivatedAt: new Date() } });
    const res = await request(app)
      .post(`/v1/admin/users/${member.id}/reactivate`)
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    const row = await prisma.user.findUnique({ where: { id: member.id } });
    expect(row?.deactivatedAt).toBeNull();
  });

  it('reactivate is a no-op on an active user', async () => {
    const { admin, member } = await seed();
    const res = await request(app)
      .post(`/v1/admin/users/${member.id}/reactivate`)
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.deactivatedAt).toBeNull();
  });

  it('cross-workspace 404', async () => {
    const a = await seed();
    const b = await seed();
    const res = await request(app)
      .post(`/v1/admin/users/${b.member.id}/deactivate`)
      .set(bearer(a.admin.token));
    expect(res.status).toBe(404);
  });
});

describe('deactivation side-effects', () => {
  it('deactivated user cannot log in', async () => {
    const { ws, stamp } = await seed();
    const u = await prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `login-${stamp}@x.com`,
        name: 'Login',
        role: 'MEMBER',
        passwordHash: await hashPassword('correctpw'),
        deactivatedAt: new Date(),
      },
    });
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: u.email, password: 'correctpw', deviceName: 'test' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('GET /admin/users excludes deactivated by default', async () => {
    const { admin, member } = await seed();
    await prisma.user.update({ where: { id: member.id }, data: { deactivatedAt: new Date() } });
    const res = await request(app).get('/v1/admin/users').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.users.find((u: { id: string }) => u.id === member.id)).toBeUndefined();
  });

  it('GET /admin/users?includeDeactivated=true surfaces deactivated', async () => {
    const { admin, member } = await seed();
    await prisma.user.update({ where: { id: member.id }, data: { deactivatedAt: new Date() } });
    const res = await request(app)
      .get('/v1/admin/users?includeDeactivated=true')
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    const row = res.body.users.find((u: { id: string }) => u.id === member.id);
    expect(row).toBeDefined();
    expect(row.deactivatedAt).toBeTruthy();
  });

  it('MANAGER cannot pass includeDeactivated', async () => {
    const { mgr, member } = await seed();
    await prisma.user.update({ where: { id: member.id }, data: { deactivatedAt: new Date() } });
    const res = await request(app)
      .get('/v1/admin/users?includeDeactivated=true')
      .set(bearer(mgr.token));
    expect(res.status).toBe(200);
    // Still filtered out — flag is admin-only.
    expect(res.body.users.find((u: { id: string }) => u.id === member.id)).toBeUndefined();
  });
});
