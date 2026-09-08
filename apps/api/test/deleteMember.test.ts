import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { createManagedTeam, fakeUlid, seedUser } from './helpers';

/**
 * Permanently deleting a member.
 *
 * Two things are worth testing here and they pull in opposite directions: that
 * everything belonging to the person really goes — six relations into `User`
 * are `Restrict` and would each block the delete on their own — and that
 * nothing belonging to anybody ELSE goes with them.
 */

const app = buildApp();

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

let seq = 0;

async function member(workspaceId: string, name: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER' = 'MEMBER') {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      workspaceId,
      email: `${name.toLowerCase()}-${Date.now()}-${seq}@test.local`,
      name,
      role,
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
    },
  });
  return { id: user.id, email: user.email, token: signAccessToken({ sub: user.id, ws: workspaceId, role }) };
}

/** A member carrying one row in every table that blocks or cascades. */
async function withData(workspaceId: string, name: string) {
  const u = await member(workspaceId, name);
  const entry = await prisma.timeEntry.create({
    data: {
      id: fakeUlid('te'),
      clientUuid: `cu-${u.id}`,
      userId: u.id,
      source: 'AUTO',
      startedAt: new Date('2026-08-03T04:00:00Z'),
      endedAt: new Date('2026-08-03T05:00:00Z'),
      segments: { create: [{ id: fakeUlid('sg'), kind: 'WORK', startedAt: new Date('2026-08-03T04:00:00Z'), endedAt: new Date('2026-08-03T05:00:00Z') }] },
    },
  });
  await prisma.activitySample.create({
    data: { id: fakeUlid('as'), userId: u.id, timeEntryId: entry.id, bucketStart: new Date('2026-08-03T04:00:00Z'), keystrokes: 10, clicks: 5, mouseDistancePx: 100, scrollEvents: 2 },
  });
  await prisma.screenshot.create({
    data: { id: fakeUlid('ss'), userId: u.id, timeEntryId: entry.id, capturedAt: new Date('2026-08-03T04:30:00Z'), s3Key: 'shots/a.jpg' },
  });
  await prisma.attendancePunch.create({
    data: { workspaceId, userId: u.id, date: new Date('2026-08-03'), note: 'biometric' },
  });
  return { ...u, entryId: entry.id };
}

async function seedWorkspace() {
  const admin = await seedUser({ role: 'ADMIN' });
  return { admin, ws: admin.workspaceId };
}

describe('DELETE /v1/admin/users/:id', () => {
  it('destroys the rows that would each have blocked the delete', async () => {
    const { admin, ws } = await seedWorkspace();
    const target = await withData(ws, 'Leaver');

    const res = await request(app)
      .delete(`/v1/admin/users/${target.id}`)
      .set(auth(admin.accessToken))
      .send({ confirmEmail: target.email });

    expect(res.status).toBe(200);
    expect(await prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await prisma.timeEntry.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.activitySample.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.screenshot.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.attendancePunch.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.timeSegment.count({ where: { timeEntryId: target.entryId } })).toBe(0);
  });

  it('keeps other people’s approved time, minus the approver’s name', async () => {
    // `ManualTimeRequest.approverId` is Restrict. Cascading it would delete
    // somebody else's approved hours because their approver left.
    const { admin, ws } = await seedWorkspace();
    const approver = await member(ws, 'Approver', 'MANAGER');
    const requester = await member(ws, 'Requester');
    const req = await prisma.manualTimeRequest.create({
      data: {
        clientUuid: `mtr-${Date.now()}-${seq}`,
        userId: requester.id,
        approverId: approver.id,
        requestedStart: new Date('2026-08-03T04:00:00Z'),
        requestedEnd: new Date('2026-08-03T05:00:00Z'),
        reason: 'Timo was off',
        status: 'APPROVED',
      },
    });

    const res = await request(app)
      .delete(`/v1/admin/users/${approver.id}`)
      .set(auth(admin.accessToken))
      .send({ confirmEmail: approver.email });

    expect(res.status).toBe(200);
    const survivor = await prisma.manualTimeRequest.findUnique({ where: { id: req.id } });
    expect(survivor).not.toBeNull();
    expect(survivor?.approverId).toBeNull();
    expect(survivor?.userId).toBe(requester.id);
  });

  it('reports what it destroyed, and what it left in storage', async () => {
    const { admin, ws } = await seedWorkspace();
    const target = await withData(ws, 'Counted');

    const res = await request(app)
      .delete(`/v1/admin/users/${target.id}`)
      .set(auth(admin.accessToken))
      .send({ confirmEmail: target.email });

    expect(res.body.deleted).toMatchObject({
      email: target.email,
      destroys: { timeEntries: 1, activitySamples: 1, screenshots: 1, attendancePunches: 1 },
      // The image is still in storage — the row pointing at it is not.
      orphanedScreenshotFiles: 1,
    });
  });
});

describe('what deletion refuses', () => {
  it('refuses without the confirmation', async () => {
    const { admin, ws } = await seedWorkspace();
    const target = await member(ws, 'Safe');

    const res = await request(app)
      .delete(`/v1/admin/users/${target.id}`)
      .set(auth(admin.accessToken))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('confirmation_required');
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
  });

  it('refuses when the confirmation names somebody else', async () => {
    const { admin, ws } = await seedWorkspace();
    const target = await member(ws, 'Safe');
    const other = await member(ws, 'Other');

    const res = await request(app)
      .delete(`/v1/admin/users/${target.id}`)
      .set(auth(admin.accessToken))
      .send({ confirmEmail: other.email });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('confirmation_mismatch');
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
  });

  it('refuses to let an admin delete themselves', async () => {
    const { admin } = await seedWorkspace();
    const self = await prisma.user.findUnique({ where: { id: admin.userId }, select: { email: true } });

    const res = await request(app)
      .delete(`/v1/admin/users/${admin.userId}`)
      .set(auth(admin.accessToken))
      .send({ confirmEmail: self!.email });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot_delete_self');
  });

  it('refuses to delete the last admin', async () => {
    const { admin, ws } = await seedWorkspace();
    const second = await member(ws, 'SecondAdmin', 'ADMIN');
    const first = await prisma.user.findUnique({ where: { id: admin.userId }, select: { email: true } });

    // The second admin can delete the first — one is left.
    const ok = await request(app)
      .delete(`/v1/admin/users/${admin.userId}`)
      .set(auth(second.token))
      .send({ confirmEmail: first!.email });
    expect(ok.status).toBe(200);

    // Now there is only one, and nobody can remove them.
    const third = await member(ws, 'ThirdAdmin', 'ADMIN');
    const res = await request(app)
      .delete(`/v1/admin/users/${second.id}`)
      .set(auth(third.token))
      .send({ confirmEmail: second.email });
    expect(res.status).toBe(200);

    const solo = await request(app)
      .delete(`/v1/admin/users/${third.id}`)
      .set(auth(third.token))
      .send({ confirmEmail: third.email });
    expect(solo.body.error).toBe('cannot_delete_self');
  });

  it('refuses while they still manage a team', async () => {
    const { admin, ws } = await seedWorkspace();
    const manager = await member(ws, 'Manager', 'MANAGER');
    await createManagedTeam({ workspaceId: ws, name: 'Team A', managerId: manager.id });

    const res = await request(app)
      .delete(`/v1/admin/users/${manager.id}`)
      .set(auth(admin.accessToken))
      .send({ confirmEmail: manager.email });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'remove_team_manager_first', teamName: 'Team A' });
  });

  it('refuses a non-admin', async () => {
    const { ws } = await seedWorkspace();
    const manager = await member(ws, 'Nosy', 'MANAGER');
    const target = await member(ws, 'Target');

    const res = await request(app)
      .delete(`/v1/admin/users/${target.id}`)
      .set(auth(manager.token))
      .send({ confirmEmail: target.email });

    expect(res.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
  });

  it('refuses somebody in another workspace', async () => {
    const { admin } = await seedWorkspace();
    const stranger = await seedUser({ role: 'MEMBER' });
    const row = await prisma.user.findUnique({ where: { id: stranger.userId }, select: { email: true } });

    const res = await request(app)
      .delete(`/v1/admin/users/${stranger.userId}`)
      .set(auth(admin.accessToken))
      .send({ confirmEmail: row!.email });

    expect(res.status).toBe(404);
    expect(await prisma.user.findUnique({ where: { id: stranger.userId } })).not.toBeNull();
  });
});

describe('GET /v1/admin/users/:id/deletion-plan', () => {
  it('counts what would go without touching anything', async () => {
    const { admin, ws } = await seedWorkspace();
    const target = await withData(ws, 'Previewed');

    const res = await request(app)
      .get(`/v1/admin/users/${target.id}/deletion-plan`)
      .set(auth(admin.accessToken));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: target.email,
      destroys: { timeEntries: 1, screenshots: 1 },
    });
    // Still there — a plan is a plan.
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
    expect(await prisma.timeEntry.count({ where: { userId: target.id } })).toBe(1);
  });
});
