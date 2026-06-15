import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { NINE_TO_SIX } from '@grind/types';

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;

async function seedProfile() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const workspace = await prisma.workspace.create({
    data: { name: `WS-profile-${stamp}` },
  });
  const manager = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: `manager-${stamp}@test.local`,
      name: 'Manager Profile',
      role: 'MANAGER',
      passwordHash: 'x'.repeat(60),
    },
  });
  const team = await prisma.team.create({
    data: {
      workspaceId: workspace.id,
      name: 'Product',
      managerId: manager.id,
    },
  });
  const shift = await prisma.shift.create({
    data: {
      workspaceId: workspace.id,
      name: 'Day Shift',
      schedule: NINE_TO_SIX,
      bufferMin: 20,
    },
  });
  const member = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: `member-${stamp}@test.local`,
      name: 'Member Profile',
      role: 'MEMBER',
      passwordHash: 'x'.repeat(60),
      teamId: team.id,
      managerId: manager.id,
      shiftId: shift.id,
      shiftAssignedAt: new Date('2026-06-01T03:30:00.000Z'),
    },
  });

  return {
    workspace,
    manager,
    team,
    shift,
    member,
    token: signAccessToken({ sub: member.id, ws: workspace.id, role: 'MEMBER' }),
  };
}

describe('/v1/profile/me', () => {
  it('returns the signed-in member profile with reporting line, shift, and policy defaults', async () => {
    const s = await seedProfile();

    const res = await request(app)
      .get('/v1/profile/me')
      .set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Member Profile');
    expect(res.body.team).toEqual({
      id: s.team.id,
      name: 'Product',
      memberCount: 1,
    });
    expect(res.body.manager).toEqual({
      id: s.manager.id,
      name: 'Manager Profile',
      email: s.manager.email,
      avatarUrl: null,
    });
    expect(res.body.shift?.name).toBe('Day Shift');
    expect(res.body.shift?.bufferMin).toBe(20);
    expect(res.body.shift?.assignedAt).toBe('2026-06-01T03:30:00.000Z');
    expect(res.body.policy).toEqual({
      captureApps: false,
      captureTitles: false,
      captureUrls: false,
      retentionDaysScreenshots: 60,
    });
  });
});
