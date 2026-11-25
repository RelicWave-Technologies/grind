import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { createManagedTeam } from './helpers';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const DAY = '2026-06-07';
const MIN = 60_000;
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

let counter = 0;

async function seed() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const ws = await prisma.workspace.create({ data: { name: `Removal WS ${stamp}` } });
  const mk = (email: string, name: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: { workspaceId: ws.id, email: `${email}-${stamp}@test.local`, name, role, passwordHash: 'x'.repeat(60) },
    });
  const admin = await mk('admin', 'Admin Ada', 'ADMIN');
  const manager = await mk('manager', 'Manager Mira', 'MANAGER');
  const member = await mk('member', 'Member Mia', 'MEMBER');
  const outsider = await mk('outsider', 'Outside Omar', 'MEMBER');
  const team = await createManagedTeam({ workspaceId: ws.id, name: 'Removal Team', managerId: manager.id });
  await prisma.user.update({ where: { id: member.id }, data: { teamId: team.id, managerId: null } });
  const token = (u: { id: string; role: 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });
  return {
    ws,
    admin: { id: admin.id, token: token(admin) },
    manager: { id: manager.id, token: token(manager) },
    member: { id: member.id, token: token(member) },
    outsider: { id: outsider.id, token: token(outsider) },
  };
}

/** One hour of tracked work, 09:00–10:00 UTC on DAY. */
async function trackHour(userId: string, source: 'AUTO' | 'MANUAL' = 'AUTO') {
  const id = `te_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date(at('09:00'));
  const endedAt = new Date(at('10:00'));
  return prisma.timeEntry.create({
    data: {
      id,
      clientUuid: `cu_${id}`,
      userId,
      source,
      startedAt,
      endedAt,
      segments: { create: [{ id: `seg_${id}`, kind: 'WORK', startedAt, endedAt }] },
    },
  });
}

const remove = (token: string, body: Record<string, unknown>) =>
  request(app).post('/v1/time-removals').set(bearer(token)).send(body);

const dayOf = (token: string, userId?: string) =>
  request(app)
    .get('/v1/insights/day')
    .query({ date: DAY, gapScope: 'calendar-day', ...(userId ? { userId } : {}) })
    .set(bearer(token));

describe('removing tracked time on Edit Time', () => {
  it('a member removes part of their own tracked time, with the reason kept on the day', async () => {
    const s = await seed();
    await trackHour(s.member.id);

    const res = await remove(s.member.token, { start: at('09:20'), end: at('09:40'), reason: 'Personal break' });
    expect(res.status).toBe(201);
    expect(res.body.removedMs).toBe(20 * MIN);

    const day = await dayOf(s.member.token);
    expect(day.status).toBe(200);
    expect(day.body.totals.workedMs).toBe(40 * MIN);
    expect(day.body.totals.invalidatedMs).toBe(20 * MIN);

    const work = day.body.blocks.filter((b: { kind: string }) => b.kind === 'WORK');
    expect(work.map((b: { invalidated?: boolean }) => Boolean(b.invalidated))).toEqual([false, true, false]);
    const removed = work[1];
    expect(removed.startedAt).toBe(new Date(at('09:20')).getTime());
    expect(removed.endedAt).toBe(new Date(at('09:40')).getTime());
    expect(removed.removal).toMatchObject({
      id: res.body.id,
      source: 'SELF',
      reason: 'Personal break',
      byUserId: s.member.id,
      byName: 'Member Mia',
    });
    // Nothing was deleted: the entry and its segment are untouched.
    const segments = await prisma.timeSegment.findMany({ where: { timeEntry: { userId: s.member.id } } });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.endedAt!.toISOString()).toBe(at('10:00'));
  });

  it('needs a real reason', async () => {
    const s = await seed();
    await trackHour(s.member.id);
    for (const reason of [undefined, '', '   ', 'no']) {
      const res = await remove(s.member.token, { start: at('09:20'), end: at('09:40'), reason });
      expect(res.status).toBe(400);
    }
    expect(await prisma.timeInvalidation.count()).toBe(0);
  });

  it('only takes time away: a window with no counted tracked time is refused', async () => {
    const s = await seed();
    await trackHour(s.member.id);

    const gap = await remove(s.member.token, { start: at('10:30'), end: at('11:00'), reason: 'Nothing here' });
    expect(gap.status).toBe(400);
    expect(gap.body.error).toBe('no_tracked_time');

    const first = await remove(s.member.token, { start: at('09:20'), end: at('09:40'), reason: 'Personal break' });
    expect(first.status).toBe(201);
    // The same stretch again (a double click) has nothing left to remove.
    const again = await remove(s.member.token, { start: at('09:20'), end: at('09:40'), reason: 'Personal break' });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('no_tracked_time');
    expect(await prisma.timeInvalidation.count()).toBe(1);
  });

  it('does not remove approved manual time — that has its own delete', async () => {
    const s = await seed();
    await trackHour(s.member.id, 'MANUAL');
    const res = await remove(s.member.token, { start: at('09:20'), end: at('09:40'), reason: 'Personal break' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_tracked_time');
  });

  it('refuses a window that is backwards, too short, or not over yet', async () => {
    const s = await seed();
    await trackHour(s.member.id);
    const backwards = await remove(s.member.token, { start: at('09:40'), end: at('09:20'), reason: 'Personal break' });
    expect(backwards.body.error).toBe('invalid_window');
    const short = await remove(s.member.token, {
      start: at('09:20'),
      end: `${DAY}T09:20:30.000Z`,
      reason: 'Personal break',
    });
    expect(short.body.error).toBe('window_too_short');
    const future = await remove(s.member.token, {
      start: new Date(Date.now() - 10 * MIN).toISOString(),
      end: new Date(Date.now() + 10 * MIN).toISOString(),
      reason: 'Personal break',
    });
    expect(future.status).toBe(400);
    expect(future.body.error).toBe('window_in_future');
  });

  it('a member cannot remove someone else’s time; their manager can', async () => {
    const s = await seed();
    await trackHour(s.member.id);

    const outsider = await remove(s.outsider.token, {
      userId: s.member.id,
      start: at('09:20'),
      end: at('09:40'),
      reason: 'Not my time',
    });
    expect(outsider.status).toBe(403);

    const manager = await remove(s.manager.token, {
      userId: s.member.id,
      start: at('09:20'),
      end: at('09:40'),
      reason: 'Was in the cafeteria',
    });
    expect(manager.status).toBe(201);
    const row = await prisma.timeInvalidation.findUniqueOrThrow({ where: { id: manager.body.id } });
    expect(row.userId).toBe(s.member.id);
    expect(row.invalidatedById).toBe(s.manager.id);
    expect(row.flagId).toBeNull();
  });
});

describe('putting removed time back', () => {
  it('is never something you do for yourself', async () => {
    const s = await seed();
    await trackHour(s.member.id);
    const made = await remove(s.member.token, { start: at('09:20'), end: at('09:40'), reason: 'Personal break' });

    const res = await request(app).delete(`/v1/time-removals/${made.body.id}`).set(bearer(s.member.token));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('restore_needs_manager');
    const day = await dayOf(s.member.token);
    expect(day.body.totals.workedMs).toBe(40 * MIN);
  });

  it('a manager restores a team member’s removed time', async () => {
    const s = await seed();
    await trackHour(s.member.id);
    const made = await remove(s.member.token, { start: at('09:20'), end: at('09:40'), reason: 'Personal break' });

    const res = await request(app).delete(`/v1/time-removals/${made.body.id}`).set(bearer(s.manager.token));
    expect(res.status).toBe(200);
    const day = await dayOf(s.member.token);
    expect(day.body.totals.workedMs).toBe(60 * MIN);
    expect(day.body.totals.invalidatedMs).toBe(0);
  });

  it('a manager cannot restore their own; an admin can', async () => {
    const s = await seed();
    await trackHour(s.manager.id);
    await trackHour(s.admin.id);
    const mine = await remove(s.manager.token, { start: at('09:20'), end: at('09:40'), reason: 'Personal break' });
    const admins = await remove(s.admin.token, { start: at('09:20'), end: at('09:40'), reason: 'Personal break' });

    const self = await request(app).delete(`/v1/time-removals/${mine.body.id}`).set(bearer(s.manager.token));
    expect(self.status).toBe(403);
    const adminSelf = await request(app).delete(`/v1/time-removals/${admins.body.id}`).set(bearer(s.admin.token));
    expect(adminSelf.status).toBe(200);
  });

  it('is out of reach outside the caller’s scope', async () => {
    const s = await seed();
    await trackHour(s.outsider.id);
    const made = await remove(s.outsider.token, { start: at('09:20'), end: at('09:40'), reason: 'Personal break' });
    const res = await request(app).delete(`/v1/time-removals/${made.body.id}`).set(bearer(s.manager.token));
    expect(res.status).toBe(404);
    expect(await prisma.timeInvalidation.count()).toBe(1);
  });
});

describe('a flag review’s invalidation on Edit Time', () => {
  async function flagInvalidation(s: Awaited<ReturnType<typeof seed>>) {
    const flag = await prisma.activityFlag.create({
      data: {
        userId: s.member.id,
        type: 'JIGGLER',
        windowStart: new Date(at('09:20')),
        windowEnd: new Date(at('09:40')),
        riskScore: 50,
        evidence: {},
        status: 'RESOLVED',
        resolution: 'TIME_INVALIDATED',
      },
    });
    return prisma.timeInvalidation.create({
      data: {
        workspaceId: s.ws.id,
        flagId: flag.id,
        userId: s.member.id,
        windowStart: flag.windowStart,
        windowEnd: flag.windowEnd,
        invalidatedById: s.manager.id,
        reason: 'Mouse jiggler pattern',
      },
    });
  }

  it('shows the reviewer’s note to a manager, not to the person it is about', async () => {
    const s = await seed();
    await trackHour(s.member.id);
    await flagInvalidation(s);

    const own = await dayOf(s.member.token);
    const ownBlock = own.body.blocks.find((b: { invalidated?: boolean }) => b.invalidated);
    expect(ownBlock.removal).toMatchObject({ source: 'REVIEW', reason: null, byName: 'Manager Mira' });

    const managers = await dayOf(s.manager.token, s.member.id);
    const managerBlock = managers.body.blocks.find((b: { invalidated?: boolean }) => b.invalidated);
    expect(managerBlock.removal).toMatchObject({ source: 'REVIEW', reason: 'Mouse jiggler pattern' });
  });

  it('is not undone from Edit Time', async () => {
    const s = await seed();
    await trackHour(s.member.id);
    const row = await flagInvalidation(s);
    const res = await request(app).delete(`/v1/time-removals/${row.id}`).set(bearer(s.manager.token));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('flag_review_invalidation');
  });
});
