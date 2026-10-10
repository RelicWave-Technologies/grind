import { describe, expect, it, beforeEach } from 'vitest';
import { consumptionSourceKey, setLeaveDecidedInLarkForTests } from '../src/leave';
import request from 'supertest';
import { prisma } from '@grind/db';
import { NINE_TO_SIX } from '@grind/types';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';


const app = buildApp();

// The real .env now carries a Lark approval code, and env.ts re-reads it after
// the suite's setup has tried to remove it. Pin the answer instead.
beforeEach(() => setLeaveDecidedInLarkForTests(false));

/** Give a user a Mon-Fri 09:00-18:00 shift, effective well before any test date. */
async function giveShift(workspaceId: string, userId: string) {
  const shift = await prisma.shift.create({
    data: { workspaceId, name: 'Day Shift', schedule: NINE_TO_SIX as object },
  });
  await prisma.shiftAssignment.create({
    data: {
      userId,
      shiftId: shift.id,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      effectiveTo: null,
      shiftNameSnapshot: 'Day Shift',
      scheduleSnapshot: NINE_TO_SIX as object,
    },
  });
  return shift;
}

async function seedAdminWithShift() {
  const admin = await seedUser({ role: 'ADMIN' });
  await prisma.workspace.update({
    where: { id: admin.workspaceId },
    data: { timezone: 'Asia/Kolkata' },
  });
  // Joined long ago so accrual has run up for a while.
  await prisma.user.update({
    where: { id: admin.userId },
    data: { joinedOn: new Date('2026-01-01T00:00:00Z') },
  });
  await giveShift(admin.workspaceId, admin.userId);
  return admin;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('accrual', () => {
  it('materialises one entry per month and is idempotent when called twice', async () => {
    const u = await seedAdminWithShift();
    const first = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    expect(first.status).toBe(200);
    const balanceAfterFirst = first.body.balance.balanceDays;
    expect(balanceAfterFirst).toBeGreaterThan(0);

    const second = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    expect(second.body.balance.balanceDays).toBe(balanceAfterFirst);

    const rows = await prisma.leaveLedgerEntry.count({ where: { userId: u.userId } });
    expect(rows).toBe(second.body.statement.length);
    // Every accrual key is distinct — that is what makes the retry a no-op.
    const keys = await prisma.leaveLedgerEntry.findMany({
      where: { userId: u.userId },
      select: { sourceKey: true },
    });
    expect(new Set(keys.map((k) => k.sourceKey)).size).toBe(keys.length);
  });

  it('accrues from joinedOn, not from the Timo account creation date', async () => {
    const u = await seedAdminWithShift();
    await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    const earliest = await prisma.leaveLedgerEntry.findFirst({
      where: { userId: u.userId, kind: 'ACCRUAL' },
      orderBy: { effectiveOn: 'asc' },
    });
    expect(earliest?.effectiveOn.toISOString().slice(0, 10)).toBe('2026-01-01');
  });
});

describe('adjustments', () => {
  it('posts an adjustment to the date it was given, not to today', async () => {
    const u = await seedAdminWithShift();
    await request(app)
      .post('/v1/admin/leave/adjust')
      .set(auth(u.accessToken))
      .send({
        userId: u.userId,
        days: 3,
        effectiveOn: '2026-08-01',
        reason: 'Opening balance carried in from before August',
      })
      .expect(201);

    const row = await prisma.leaveLedgerEntry.findFirst({
      where: { userId: u.userId, sourceKey: { startsWith: 'adjust:' } },
    });
    // An adjustment posted while reading August has to land in August, or the
    // person who went looking for it in August cannot see it.
    expect(row!.effectiveOn.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(row!.reason).toBe('Opening balance carried in from before August');
  });

  it('refuses an adjustment with no reason', async () => {
    const u = await seedAdminWithShift();
    await request(app)
      .post('/v1/admin/leave/adjust')
      .set(auth(u.accessToken))
      .send({ userId: u.userId, days: 1, effectiveOn: '2026-08-01' })
      .expect(400);
    await request(app)
      .post('/v1/admin/leave/adjust')
      .set(auth(u.accessToken))
      .send({ userId: u.userId, days: 1, effectiveOn: '2026-08-01', reason: '   ' })
      .expect(400);
  });
});

describe('holidays', () => {
  it('rejects a duplicate workspace-wide holiday on the same date', async () => {
    const u = await seedAdminWithShift();
    await request(app)
      .post('/v1/admin/leave/holidays')
      .set(auth(u.accessToken))
      .send({ date: '2026-08-19', name: 'Holi' })
      .expect(201);
    const dup = await request(app)
      .post('/v1/admin/leave/holidays')
      .set(auth(u.accessToken))
      .send({ date: '2026-08-19', name: 'Holi again' });
    expect(dup.status).toBe(409);
  });

  it('a member cannot create a holiday', async () => {
    const admin = await seedAdminWithShift();
    const member = await prisma.user.create({
      data: {
        workspaceId: admin.workspaceId,
        email: `m-${Date.now()}@test.local`,
        name: 'Member',
        role: 'MEMBER',
        provisioningStatus: 'ACTIVE',
      },
    });
    const { signAccessToken } = await import('../src/lib/jwt');
    const token = signAccessToken({ sub: member.id, ws: admin.workspaceId, role: 'MEMBER' });
    const res = await request(app)
      .post('/v1/admin/leave/holidays')
      .set(auth(token))
      .send({ date: '2026-08-19', name: 'Nope' });
    expect(res.status).toBe(403);
  });
});

describe('calendar view', () => {
  it('reports who is away, and the holidays in range', async () => {
    const u = await seedAdminWithShift();
    await request(app)
      .post('/v1/admin/leave/holidays')
      .set(auth(u.accessToken))
      .send({ date: '2026-08-19', name: 'Holi' })
      .expect(201);

    // Materialise accruals so the charge below is funded.
    await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken)).expect(200);
    // Leave arrives approved from Lark; write what the ingest would.
    const leave = await prisma.leaveRequest.create({
      data: {
        clientUuid: `cal-${u.userId}`,
        workspaceId: u.workspaceId,
        userId: u.userId,
        startDate: new Date('2026-08-17T00:00:00Z'),
        endDate: new Date('2026-08-17T00:00:00Z'),
        portion: 'SECOND_HALF',
        chargedDays: 0.5,
        reason: 'x',
        status: 'APPROVED',
        decisionSource: 'LARK_APPROVAL',
        decidedAt: new Date(),
      },
    });
    await prisma.leaveLedgerEntry.create({
      data: {
        workspaceId: u.workspaceId,
        userId: u.userId,
        kind: 'CONSUMPTION',
        days: -0.5,
        effectiveOn: new Date('2026-08-17T00:00:00Z'),
        sourceKey: consumptionSourceKey(leave.id),
        reason: 'Paid leave (Lark)',
        requestId: leave.id,
      },
    });

    const cal = await request(app)
      .get('/v1/leave/calendar?from=2026-08-15&to=2026-08-25')
      .set(auth(u.accessToken));
    expect(cal.status).toBe(200);
    expect(cal.body.holidays.map((h: { name: string }) => h.name)).toEqual(['Holi']);
    expect(cal.body.away[u.userId]).toEqual([
      { date: '2026-08-17', kind: 'PAID_LEAVE', portion: 'SECOND_HALF', label: 'Paid leave' },
    ]);
    expect(cal.body.wfh).toEqual({});
  });

  /** A WFH request as the Lark ingest writes it: whole days, end inclusive. */
  async function wfh(workspaceId: string, userId: string, start: string, end: string, status: 'APPROVED' | 'PENDING' = 'APPROVED') {
    await prisma.wfhRequest.create({
      data: {
        workspaceId,
        userId,
        startDate: new Date(`${start}T00:00:00Z`),
        endDate: new Date(`${end}T00:00:00Z`),
        reason: 'x',
        status,
        larkInstanceCode: `wfh-${userId}-${start}-${status}`,
      },
    });
  }

  it('reports approved work-from-home on working days, apart from leave', async () => {
    const u = await seedAdminWithShift();
    await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken)).expect(200);

    // Starts before the window: only its days inside it count.
    await wfh(u.workspaceId, u.userId, '2026-09-10', '2026-09-15');
    // Fri to Mon: the end is inclusive, and the weekend between asks for no work.
    await wfh(u.workspaceId, u.userId, '2026-09-18', '2026-09-21');
    // Not approved yet, so not on the calendar.
    await wfh(u.workspaceId, u.userId, '2026-09-23', '2026-09-23', 'PENDING');
    // WFH and leave on the same day: leave wins.
    await wfh(u.workspaceId, u.userId, '2026-09-24', '2026-09-24');
    await prisma.leaveRequest.create({
      data: {
        clientUuid: `cal-wfh-${u.userId}`,
        workspaceId: u.workspaceId,
        userId: u.userId,
        startDate: new Date('2026-09-24T00:00:00Z'),
        endDate: new Date('2026-09-24T00:00:00Z'),
        portion: 'FULL',
        chargedDays: 1,
        reason: 'x',
        status: 'APPROVED',
        decisionSource: 'LARK_APPROVAL',
        decidedAt: new Date(),
      },
    });

    const cal = await request(app)
      .get('/v1/leave/calendar?from=2026-09-14&to=2026-09-27')
      .set(auth(u.accessToken));
    expect(cal.status).toBe(200);
    expect(cal.body.wfh).toEqual({ [u.userId]: ['2026-09-14', '2026-09-15', '2026-09-18', '2026-09-21'] });
    expect(cal.body.away[u.userId].map((d: { date: string }) => d.date)).toEqual(['2026-09-24']);
  });

  it('shows work-from-home only for the people in the caller’s scope', async () => {
    const admin = await seedAdminWithShift();
    const member = await prisma.user.create({
      data: {
        workspaceId: admin.workspaceId,
        email: `m-${Date.now()}@test.local`,
        name: 'Member',
        role: 'MEMBER',
        provisioningStatus: 'ACTIVE',
      },
    });
    await giveShift(admin.workspaceId, member.id);
    await wfh(admin.workspaceId, admin.userId, '2026-09-16', '2026-09-16');
    await wfh(admin.workspaceId, member.id, '2026-09-17', '2026-09-17');
    const { signAccessToken } = await import('../src/lib/jwt');
    const memberToken = signAccessToken({ sub: member.id, ws: admin.workspaceId, role: 'MEMBER' });

    const mine = await request(app)
      .get('/v1/leave/calendar?from=2026-09-14&to=2026-09-20')
      .set(auth(memberToken));
    expect(mine.status).toBe(200);
    expect(mine.body.wfh).toEqual({ [member.id]: ['2026-09-17'] });

    const everyone = await request(app)
      .get('/v1/leave/calendar?from=2026-09-14&to=2026-09-20')
      .set(auth(admin.accessToken));
    expect(everyone.body.wfh).toEqual({ [admin.userId]: ['2026-09-16'], [member.id]: ['2026-09-17'] });
  });
});

describe('per-person accrual rate', () => {
  it('uses the workspace policy when the person has no override', async () => {
    const u = await seedAdminWithShift(); // joinedOn 2026-01-01, policy 1/month
    const res = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    const withPolicy = res.body.balance.accruedDays;
    expect(withPolicy).toBeGreaterThan(0);

    const months = await prisma.leaveLedgerEntry.count({
      where: { userId: u.userId, kind: 'ACCRUAL' },
    });
    // One day a month, so the totals have to agree.
    expect(withPolicy).toBe(months);
  });

  it('honours a per-person rate of 2 a month', async () => {
    const u = await seedAdminWithShift();
    await prisma.user.update({
      where: { id: u.userId },
      data: { leaveAccrualDaysOverride: 2 },
    });

    const res = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    const months = await prisma.leaveLedgerEntry.count({
      where: { userId: u.userId, kind: 'ACCRUAL' },
    });
    expect(res.body.balance.accruedDays).toBe(months * 2);
  });

  it('two people in the same workspace can accrue at different rates', async () => {
    const one = await seedAdminWithShift();
    const two = await prisma.user.create({
      data: {
        workspaceId: one.workspaceId,
        email: `two-${Date.now()}@test.local`,
        name: 'Two',
        role: 'MEMBER',
        provisioningStatus: 'ACTIVE',
        joinedOn: new Date('2026-01-01T00:00:00Z'),
        leaveAccrualDaysOverride: 2,
      },
    });
    const { signAccessToken } = await import('../src/lib/jwt');
    const tokenTwo = signAccessToken({ sub: two.id, ws: one.workspaceId, role: 'MEMBER' });

    const a = await request(app).get('/v1/leave/me/balance').set(auth(one.accessToken));
    const b = await request(app).get('/v1/leave/me/balance').set(auth(tokenTwo));

    // Same workspace, same months, twice the grant.
    expect(b.body.balance.accruedDays).toBe(a.body.balance.accruedDays * 2);
  });

  it('a rate change only affects months not already granted', async () => {
    const u = await seedAdminWithShift();
    await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    const before = await prisma.leaveLedgerEntry.count({
      where: { userId: u.userId, kind: 'ACCRUAL' },
    });

    // Raising the rate must not silently rewrite history: the months already
    // written keep their sourceKey and are skipped.
    await prisma.user.update({
      where: { id: u.userId }, data: { leaveAccrualDaysOverride: 2 },
    });
    const res = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));

    expect(await prisma.leaveLedgerEntry.count({
      where: { userId: u.userId, kind: 'ACCRUAL' },
    })).toBe(before);
    expect(res.body.balance.accruedDays).toBe(before);
  });
});
