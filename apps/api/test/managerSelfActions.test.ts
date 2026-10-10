import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { createManagedTeam, seedUser } from './helpers';

/**
 * A manager is inside their own scope, so every "act on somebody in my team"
 * endpoint would also let them act on themselves — mark their own LWA day
 * present, dismiss their own anti-cheat flag, approve their own time. Each of
 * those is an admin's call. This file walks every such endpoint as a manager
 * acting on themselves and expects a refusal, so a new endpoint that forgets
 * the check fails here rather than in production.
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function seed() {
  const admin = await seedUser({ role: 'ADMIN' });
  const manager = await prisma.user.create({
    data: {
      workspaceId: admin.workspaceId,
      email: `mgr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
      name: 'Self Manager',
      role: 'MANAGER',
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
    },
  });
  const team = await createManagedTeam({ workspaceId: admin.workspaceId, name: 'Self Team', managerId: manager.id });
  const member = await prisma.user.create({
    data: {
      workspaceId: admin.workspaceId,
      email: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
      name: 'Team Member',
      role: 'MEMBER',
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
      teamId: team.id,
    },
  });
  const token = signAccessToken({ sub: manager.id, ws: admin.workspaceId, role: 'MANAGER' });
  return { admin, manager, member, token };
}

let flagCounter = 0;
async function ownFlag(userId: string) {
  flagCounter += 1;
  const windowStart = new Date(Date.UTC(2026, 8, 10, 9, flagCounter));
  return prisma.activityFlag.create({
    data: {
      userId,
      type: 'METRONOMIC',
      windowStart,
      windowEnd: new Date(windowStart.getTime() + 30 * 60_000),
      riskScore: 60,
      evidence: {},
    },
  });
}

describe('a manager cannot act on their own records', () => {
  it('cannot correct their own attendance day', async () => {
    const s = await seed();
    const set = await request(app)
      .put('/v1/reports/attendance-override')
      .set(bearer(s.token))
      .send({ userId: s.manager.id, date: '2026-09-10', code: 'P', reason: 'I was here' });
    expect(set.status).toBe(403);
    expect(set.body.error).toBe('self_override_forbidden');

    const clear = await request(app)
      .delete('/v1/reports/attendance-override')
      .set(bearer(s.token))
      .send({ userId: s.manager.id, date: '2026-09-10', reason: 'undo' });
    expect(clear.status).toBe(403);
    expect(clear.body.error).toBe('self_override_forbidden');
  });

  it('cannot resolve their own anti-cheat flag, one at a time or in bulk', async () => {
    const s = await seed();
    const flag = await ownFlag(s.manager.id);
    const teamFlag = await ownFlag(s.member.id);

    const one = await request(app)
      .post(`/v1/admin/flags/${flag.id}/resolve`)
      .set(bearer(s.token))
      .send({ resolution: 'DISMISSED' });
    expect(one.status).toBe(403);
    expect(one.body.error).toBe('self_review_forbidden');

    const many = await request(app)
      .post('/v1/admin/flags/resolve-many')
      .set(bearer(s.token))
      .send({ flagIds: [teamFlag.id, flag.id], resolution: 'DISMISSED' });
    expect(many.status).toBe(403);
    expect(many.body.error).toBe('self_review_forbidden');

    // A refused batch resolves none of it, the team's flag included.
    const still = await prisma.activityFlag.findMany({ where: { id: { in: [flag.id, teamFlag.id] } } });
    expect(still.every((f) => f.status === 'OPEN')).toBe(true);
  });

  it('cannot change their own team settings', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.manager.id}`)
      .set(bearer(s.token))
      .send({ screenshotIntervalMin: 30 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('self_settings_forbidden');
  });

  it('still lets a manager act on their team', async () => {
    const s = await seed();
    const day = await request(app)
      .put('/v1/reports/attendance-override')
      .set(bearer(s.token))
      .send({ userId: s.member.id, date: '2026-09-10', code: 'P', reason: 'was in office' });
    expect(day.status).toBe(200);

    const teamFlag = await ownFlag(s.member.id);
    const flag = await request(app)
      .post(`/v1/admin/flags/${teamFlag.id}/resolve`)
      .set(bearer(s.token))
      .send({ resolution: 'DISMISSED' });
    expect(flag.status).toBe(200);
  });

  it('still lets an admin correct anyone, themselves included', async () => {
    const s = await seed();
    const res = await request(app)
      .put('/v1/reports/attendance-override')
      .set(bearer(s.admin.accessToken))
      .send({ userId: s.manager.id, date: '2026-09-10', code: 'P', reason: 'checked with HR' });
    expect(res.status).toBe(200);

    const own = await request(app)
      .put('/v1/reports/attendance-override')
      .set(bearer(s.admin.accessToken))
      .send({ userId: s.admin.userId, date: '2026-09-10', code: 'P', reason: 'was in office' });
    expect(own.status).toBe(200);

    const adminFlag = await ownFlag(s.admin.userId);
    const resolved = await request(app)
      .post(`/v1/admin/flags/${adminFlag.id}/resolve`)
      .set(bearer(s.admin.accessToken))
      .send({ resolution: 'DISMISSED' });
    expect(resolved.status).toBe(200);
  });
});
