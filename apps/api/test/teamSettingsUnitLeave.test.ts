import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { createManagedTeam, seedUser } from './helpers';

/**
 * Team settings carry two payroll facts beside the capture settings: the unit
 * (which employer) and the paid leave earned per month. Only an admin sets them;
 * a manager sees them on their team and is refused if they send either.
 */

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function seed() {
  const admin = await seedUser({ role: 'ADMIN' });
  const ws = admin.workspaceId;
  const unit = await prisma.unit.create({ data: { workspaceId: ws, name: `EMIAC-${Math.random().toString(36).slice(2, 7)}` } });
  const manager = await prisma.user.create({
    data: {
      workspaceId: ws,
      email: `mgr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
      name: 'Unit Manager',
      role: 'MANAGER',
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
    },
  });
  const team = await createManagedTeam({ workspaceId: ws, name: 'Unit Team', managerId: manager.id });
  const member = await prisma.user.create({
    data: {
      workspaceId: ws,
      email: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
      name: 'Unit Member',
      role: 'MEMBER',
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
      teamId: team.id,
    },
  });
  return {
    admin, manager, member, unit,
    adminToken: admin.accessToken,
    managerToken: signAccessToken({ sub: manager.id, ws, role: 'MANAGER' }),
  };
}

describe('team settings: unit and paid leave per month', () => {
  it('lets an admin set and clear the unit and the monthly leave rate', async () => {
    const s = await seed();
    const set = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.member.id}`)
      .set(bearer(s.adminToken))
      .send({ unitId: s.unit.id, leaveAccrualDays: 1.5 });
    expect(set.status).toBe(200);
    expect(set.body.unit).toEqual({ id: s.unit.id, name: s.unit.name });
    expect(set.body.leaveAccrualDays).toBe(1.5);
    expect(set.body.effectiveLeaveAccrualDays).toBe(1.5);

    const list = await request(app).get('/v1/admin/team-member-settings').set(bearer(s.adminToken));
    expect(list.status).toBe(200);
    expect(list.body.units.map((u: { id: string }) => u.id)).toContain(s.unit.id);

    const cleared = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.member.id}`)
      .set(bearer(s.adminToken))
      .send({ unitId: null, leaveAccrualDays: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.unit).toBeNull();
    expect(cleared.body.leaveAccrualDays).toBeNull();
    const db = await prisma.user.findUniqueOrThrow({ where: { id: s.member.id }, select: { unitId: true, leaveAccrualDaysOverride: true } });
    expect(db).toEqual({ unitId: null, leaveAccrualDaysOverride: null });
  });

  it('refuses a rate that is not whole or half days', async () => {
    const s = await seed();
    const res = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.member.id}`)
      .set(bearer(s.adminToken))
      .send({ leaveAccrualDays: 1.25 });
    expect(res.status).toBe(400);
  });

  it("refuses another workspace's unit", async () => {
    const s = await seed();
    const other = await seedUser({ role: 'ADMIN' });
    const foreign = await prisma.unit.create({ data: { workspaceId: other.workspaceId, name: 'MACOBS' } });
    const res = await request(app)
      .patch(`/v1/admin/team-member-settings/${s.member.id}`)
      .set(bearer(s.adminToken))
      .send({ unitId: foreign.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unit_out_of_workspace');
  });

  it('refuses a manager who sends either, and leaves the person unchanged', async () => {
    const s = await seed();
    for (const body of [{ unitId: s.unit.id }, { leaveAccrualDays: 2 }]) {
      const res = await request(app)
        .patch(`/v1/admin/team-member-settings/${s.member.id}`)
        .set(bearer(s.managerToken))
        .send(body);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('admin_required_for_unit_or_leave_rate');
    }
    const db = await prisma.user.findUniqueOrThrow({ where: { id: s.member.id }, select: { unitId: true, leaveAccrualDaysOverride: true } });
    expect(db).toEqual({ unitId: null, leaveAccrualDaysOverride: null });

    const list = await request(app).get('/v1/admin/team-member-settings').set(bearer(s.managerToken));
    expect(list.status).toBe(200);
    expect(list.body.members.find((m: { id: string }) => m.id === s.member.id)).toMatchObject({ unit: null, leaveAccrualDays: null });
  });
});
