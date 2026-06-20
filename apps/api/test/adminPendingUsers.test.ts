import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { NINE_TO_SIX } from '@grind/types';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-pend`;
  const ws = await prisma.workspace.create({ data: { name: `WS ${stamp}` } });
  const mk = (
    email: string,
    role: 'ADMIN' | 'MANAGER' | 'MEMBER',
    provisioningStatus: 'PENDING' | 'ACTIVE',
    deactivatedAt: Date | null = null,
  ) =>
    prisma.user.create({
      data: { workspaceId: ws.id, email: `${email}-${stamp}@test.local`, name: email, role, provisioningStatus, deactivatedAt, passwordHash: null },
    });
  const admin = await mk('admin', 'ADMIN', 'ACTIVE');
  const active = await mk('active', 'MEMBER', 'ACTIVE');
  const pending1 = await mk('pend1', 'MEMBER', 'PENDING');
  const pending2 = await mk('pend2', 'MEMBER', 'PENDING');
  const token = signAccessToken({ sub: admin.id, ws: ws.id, role: 'ADMIN' });
  return { ws, adminToken: token, active, pending1, pending2 };
}

describe('admin pending users', () => {
  it('GET /v1/admin/users?status=pending returns only PENDING users', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/users?status=pending').set(bearer(s.adminToken));
    expect(res.status).toBe(200);
    const ids = (res.body.users as { id: string; provisioningStatus: string }[]).map((u) => u.id).sort();
    expect(ids).toEqual([s.pending1.id, s.pending2.id].sort());
    expect((res.body.users as { provisioningStatus: string }[]).every((u) => u.provisioningStatus === 'PENDING')).toBe(true);
  });

  it('GET /v1/admin/users (no filter) includes provisioningStatus on every row', async () => {
    const s = await seed();
    const res = await request(app).get('/v1/admin/users').set(bearer(s.adminToken));
    expect(res.status).toBe(200);
    expect((res.body.users as { provisioningStatus?: string }[]).every((u) => typeof u.provisioningStatus === 'string')).toBe(true);
  });

  it('POST /v1/admin/users/:id/activate flips PENDING → ACTIVE', async () => {
    const s = await seed();
    const res = await request(app).post(`/v1/admin/users/${s.pending1.id}/activate`).set(bearer(s.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.provisioningStatus).toBe('ACTIVE');
    const row = await prisma.user.findUnique({ where: { id: s.pending1.id }, select: { provisioningStatus: true } });
    expect(row?.provisioningStatus).toBe('ACTIVE');
  });

  it('PATCH /v1/admin/users/:id activates a pending user once team and shift are assigned', async () => {
    const s = await seed();
    const team = await prisma.team.create({ data: { workspaceId: s.ws.id, name: 'Setup team' } });
    const shift = await prisma.shift.create({
      data: { workspaceId: s.ws.id, name: 'Day', schedule: NINE_TO_SIX, bufferMin: 30 },
    });

    const teamOnly = await request(app)
      .patch(`/v1/admin/users/${s.pending1.id}`)
      .set(bearer(s.adminToken))
      .send({ teamId: team.id });
    expect(teamOnly.status).toBe(200);
    expect(teamOnly.body.provisioningStatus).toBe('PENDING');

    const completed = await request(app)
      .patch(`/v1/admin/users/${s.pending1.id}`)
      .set(bearer(s.adminToken))
      .send({ shiftId: shift.id });
    expect(completed.status).toBe(200);
    expect(completed.body.provisioningStatus).toBe('ACTIVE');

    const row = await prisma.user.findUnique({
      where: { id: s.pending1.id },
      select: { provisioningStatus: true, teamId: true, shiftId: true },
    });
    expect(row).toMatchObject({ provisioningStatus: 'ACTIVE', teamId: team.id, shiftId: shift.id });
  });

  it('activate is idempotent on an already-active user', async () => {
    const s = await seed();
    const res = await request(app).post(`/v1/admin/users/${s.active.id}/activate`).set(bearer(s.adminToken));
    expect(res.status).toBe(200);
    expect(res.body.provisioningStatus).toBe('ACTIVE');
  });

  it('activate rejects a deactivated user with 409', async () => {
    const s = await seed();
    await prisma.user.update({ where: { id: s.pending2.id }, data: { deactivatedAt: new Date() } });
    const res = await request(app).post(`/v1/admin/users/${s.pending2.id}/activate`).set(bearer(s.adminToken));
    expect(res.status).toBe(409);
  });

  it('activate requires ADMIN (non-admin → 403)', async () => {
    const s = await seed();
    const memberToken = signAccessToken({ sub: s.active.id, ws: s.ws.id, role: 'MEMBER' });
    const res = await request(app).post(`/v1/admin/users/${s.pending1.id}/activate`).set(bearer(memberToken));
    expect(res.status).toBe(403);
  });

  it('invite pre-creates an ACTIVE, password-less user', async () => {
    const s = await seed();
    const res = await request(app)
      .post('/v1/admin/users')
      .set(bearer(s.adminToken))
      .send({ email: `invitee-${Date.now()}@x.com`, name: 'Invitee', role: 'MEMBER' });
    expect(res.status).toBe(201);
    expect(res.body.provisioningStatus).toBe('ACTIVE');
    const row = await prisma.user.findUnique({ where: { id: res.body.id }, select: { passwordHash: true } });
    expect(row?.passwordHash).toBeNull();
  });
});
