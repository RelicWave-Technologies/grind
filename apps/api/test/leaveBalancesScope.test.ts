import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { createManagedTeam, seedUser } from './helpers';

/**
 * Who `GET /v1/admin/leave/balances` answers with.
 *
 * The Calendar's Balances tab is open to everybody, and the only thing keeping
 * a member from reading the whole company's leave is that this route answers in
 * the caller's own scope. That used to be belt-and-braces — the tab was admin
 * only, so the scoping was never the thing standing between a member and other
 * people's balances. Now it is, so it is tested directly.
 *
 * The write routes are checked here too. They are `requireAdmin`, and a manager
 * being refused is what makes hiding the buttons a courtesy rather than the
 * control.
 */

const app = buildApp();

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

let seq = 0;

/** An admin, a manager with one report, and an unrelated member — one workspace. */
async function seedWorkspace() {
  const admin = await seedUser({ role: 'ADMIN' });
  const ws = admin.workspaceId;

  // Built in the admin's workspace rather than moved into it: the access token
  // carries the workspace it was signed for, so a user relocated afterwards
  // authenticates against a workspace they are no longer in.
  const make = async (name: string, role: 'MANAGER' | 'MEMBER') => {
    seq += 1;
    const user = await prisma.user.create({
      data: {
        workspaceId: ws,
        email: `${name.toLowerCase()}-${Date.now()}-${seq}@test.local`,
        name,
        role,
        provisioningStatus: 'ACTIVE',
        passwordHash: 'x'.repeat(60),
      },
    });
    return {
      userId: user.id,
      workspaceId: ws,
      accessToken: signAccessToken({ sub: user.id, ws, role }),
    };
  };

  const manager = await make('Manager', 'MANAGER');
  const report = await make('Report', 'MEMBER');
  const outsider = await make('Outsider', 'MEMBER');

  const team = await createManagedTeam({ workspaceId: ws, name: 'Team A', managerId: manager.userId });
  await prisma.user.update({ where: { id: report.userId }, data: { teamId: team.id } });

  return { admin, manager, report, outsider, ws };
}

async function balanceUserIds(token: string): Promise<string[]> {
  const res = await request(app).get('/v1/admin/leave/balances').set(auth(token));
  expect(res.status).toBe(200);
  return (res.body.rows as Array<{ userId: string }>).map((r) => r.userId).sort();
}

describe('GET /v1/admin/leave/balances — scope', () => {
  it('gives a member their own row and nobody else', async () => {
    const s = await seedWorkspace();

    expect(await balanceUserIds(s.outsider.accessToken)).toEqual([s.outsider.userId]);
  });

  it('gives a manager their team and themselves, not the whole workspace', async () => {
    const s = await seedWorkspace();

    const ids = await balanceUserIds(s.manager.accessToken);

    expect(ids).toEqual([s.manager.userId, s.report.userId].sort());
    expect(ids).not.toContain(s.admin.userId);
    expect(ids).not.toContain(s.outsider.userId);
  });

  it('gives an admin everyone in the workspace', async () => {
    const s = await seedWorkspace();

    const ids = await balanceUserIds(s.admin.accessToken);

    expect(ids).toEqual(
      [s.admin.userId, s.manager.userId, s.report.userId, s.outsider.userId].sort(),
    );
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).get('/v1/admin/leave/balances');

    expect(res.status).toBe(401);
  });
});

describe('GET /v1/admin/leave/balances — accrual start', () => {
  it('falls back to the account creation day in the workspace calendar, not UTC', async () => {
    const s = await seedWorkspace();
    await prisma.workspace.update({ where: { id: s.ws }, data: { timezone: 'Asia/Kolkata' } });
    // 01:30 IST on 1 August is still 31 July in UTC.
    await prisma.user.update({
      where: { id: s.report.userId },
      data: { createdAt: new Date('2026-07-31T20:00:00.000Z'), joinedOn: null },
    });

    const res = await request(app).get('/v1/admin/leave/balances').set(auth(s.admin.accessToken));

    expect(res.status).toBe(200);
    const row = (res.body.rows as Array<{ userId: string; accrualStart: string }>)
      .find((r) => r.userId === s.report.userId);
    expect(row?.accrualStart).toBe('2026-08-01');
  });
});

describe('leave writes stay admin-only', () => {
  it('refuses a manager posting an adjustment for their own report', async () => {
    const s = await seedWorkspace();

    const res = await request(app)
      .post('/v1/admin/leave/adjust')
      .set(auth(s.manager.accessToken))
      .send({ userId: s.report.userId, days: 1, reason: 'nice work' });

    expect(res.status).toBe(403);
  });

  it('refuses a member adjusting their own balance', async () => {
    const s = await seedWorkspace();

    const res = await request(app)
      .post('/v1/admin/leave/adjust')
      .set(auth(s.outsider.accessToken))
      .send({ userId: s.outsider.userId, days: 5, reason: 'a gift to myself' });

    expect(res.status).toBe(403);
  });

  it('refuses a manager editing a report’s accrual settings', async () => {
    const s = await seedWorkspace();

    const res = await request(app)
      .patch(`/v1/admin/leave/members/${s.report.userId}`)
      .set(auth(s.manager.accessToken))
      .send({ accrualDays: 5 });

    expect(res.status).toBe(403);
  });
});
