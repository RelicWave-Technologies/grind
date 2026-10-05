import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { createManagedTeam } from './helpers';

/**
 * A manager's scope includes themselves (so "My Day" works). That used to make
 * them the one person able to correct their own attendance and dismiss their
 * own anti-cheat flags. Those go to an admin now; admins keep the ability.
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `WS-self-${stamp}` } });
  const mk = (tag: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: { workspaceId: ws.id, email: `${tag}-${stamp}@test.local`, name: tag, role, passwordHash: 'x'.repeat(60) },
    });
  const admin = await mk('admin', 'ADMIN');
  const mgr = await mk('mgr', 'MANAGER');
  const mem = await mk('mem', 'MEMBER');
  const team = await createManagedTeam({ workspaceId: ws.id, name: 'T', managerId: mgr.id });
  await prisma.user.updateMany({ where: { id: { in: [mgr.id, mem.id] } }, data: { teamId: team.id } });
  const tok = (u: { id: string }, role: 'ADMIN' | 'MANAGER' | 'MEMBER') => signAccessToken({ sub: u.id, ws: ws.id, role });
  return {
    admin: { id: admin.id, token: tok(admin, 'ADMIN') },
    mgr: { id: mgr.id, token: tok(mgr, 'MANAGER') },
    mem: { id: mem.id, token: tok(mem, 'MEMBER') },
  };
}

let windowCounter = 0;
async function openFlag(userId: string) {
  windowCounter += 1;
  const windowStart = new Date(Date.UTC(2026, 8, 1, 9, windowCounter));
  return prisma.activityFlag.create({
    data: {
      userId,
      type: 'METRONOMIC',
      windowStart,
      windowEnd: new Date(windowStart.getTime() + 60_000),
      riskScore: 40,
      evidence: {},
    },
  });
}

describe('attendance overrides on your own record', () => {
  it('a manager cannot set or clear their own day', async () => {
    const s = await seed();
    const put = await request(app)
      .put('/v1/reports/attendance-override')
      .set(bearer(s.mgr.token))
      .send({ userId: s.mgr.id, date: '2026-08-03', code: 'P', reason: 'I was in' });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe('self_override_forbidden');

    const del = await request(app)
      .delete('/v1/reports/attendance-override')
      .set(bearer(s.mgr.token))
      .send({ userId: s.mgr.id, date: '2026-08-03', reason: 'undo' });
    expect(del.status).toBe(403);
    expect(del.body.error).toBe('self_override_forbidden');
    expect(await prisma.attendanceOverride.count({ where: { userId: s.mgr.id } })).toBe(0);
  });

  it('a manager can still correct their team, and an admin their own day', async () => {
    const s = await seed();
    const team = await request(app)
      .put('/v1/reports/attendance-override')
      .set(bearer(s.mgr.token))
      .send({ userId: s.mem.id, date: '2026-08-03', code: 'P', reason: 'was in office' });
    expect(team.status).toBe(200);

    const own = await request(app)
      .put('/v1/reports/attendance-override')
      .set(bearer(s.admin.token))
      .send({ userId: s.admin.id, date: '2026-08-03', code: 'P', reason: 'was in office' });
    expect(own.status).toBe(200);
  });
});

describe('anti-cheat flags on your own record', () => {
  it('a manager cannot resolve their own flag, singly or in bulk', async () => {
    const s = await seed();
    const flag = await openFlag(s.mgr.id);
    const single = await request(app)
      .post(`/v1/admin/flags/${flag.id}/resolve`)
      .set(bearer(s.mgr.token))
      .send({ resolution: 'DISMISSED' });
    expect(single.status).toBe(403);
    expect(single.body.error).toBe('self_resolution_forbidden');

    const teamFlag = await openFlag(s.mem.id);
    const bulk = await request(app)
      .post('/v1/admin/flags/resolve-many')
      .set(bearer(s.mgr.token))
      .send({ flagIds: [teamFlag.id, flag.id], resolution: 'DISMISSED' });
    expect(bulk.status).toBe(403);
    expect(bulk.body.error).toBe('self_resolution_forbidden');

    const still = await prisma.activityFlag.findMany({ where: { id: { in: [flag.id, teamFlag.id] } } });
    expect(still.every((f) => f.status === 'OPEN')).toBe(true);
  });

  it('a manager resolves their team’s flag; an admin resolves their own', async () => {
    const s = await seed();
    const teamFlag = await openFlag(s.mem.id);
    const team = await request(app)
      .post(`/v1/admin/flags/${teamFlag.id}/resolve`)
      .set(bearer(s.mgr.token))
      .send({ resolution: 'DISMISSED' });
    expect(team.status).toBe(200);

    const adminFlag = await openFlag(s.admin.id);
    const own = await request(app)
      .post(`/v1/admin/flags/${adminFlag.id}/resolve`)
      .set(bearer(s.admin.token))
      .send({ resolution: 'DISMISSED' });
    expect(own.status).toBe(200);
  });
});
