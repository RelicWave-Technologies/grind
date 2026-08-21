import { describe, expect, it, beforeEach } from 'vitest';
import { setLeaveDecidedInLarkForTests } from '../src/leave';
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

describe('quote — pricing before submitting', () => {
  it('charges 1 day for a single working day', async () => {
    const u = await seedAdminWithShift();
    const res = await request(app)
      .post('/v1/leave/quote')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-17', endDate: '2026-08-17', portion: 'FULL', kind: 'PAID', reason: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.chargedDays).toBe(1);
  });

  it('charges 0.5 for a half day', async () => {
    const u = await seedAdminWithShift();
    const res = await request(app)
      .post('/v1/leave/quote')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-17', endDate: '2026-08-17', portion: 'FIRST_HALF', kind: 'PAID', reason: 'x' });
    expect(res.body.chargedDays).toBe(0.5);
  });

  it('does not charge for a company holiday inside the range', async () => {
    const u = await seedAdminWithShift();
    await request(app)
      .post('/v1/admin/leave/holidays')
      .set(auth(u.accessToken))
      .send({ date: '2026-08-19', name: 'Holi' })
      .expect(201);

    const res = await request(app)
      .post('/v1/leave/quote')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-18', endDate: '2026-08-20', portion: 'FULL', kind: 'PAID', reason: 'x' });
    // Three days requested, one of them a holiday.
    expect(res.body.chargedDays).toBe(2);
    expect(res.body.days.map((d: { kind: string }) => d.kind)).toEqual(['PAID_LEAVE', 'HOLIDAY', 'PAID_LEAVE']);
  });

  it('does not charge for the weekend inside the range', async () => {
    const u = await seedAdminWithShift();
    const res = await request(app)
      .post('/v1/leave/quote')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-21', endDate: '2026-08-24', portion: 'FULL', kind: 'PAID', reason: 'x' });
    expect(res.body.chargedDays).toBe(2);
  });

  it('charges nothing for unpaid leave', async () => {
    const u = await seedAdminWithShift();
    const res = await request(app)
      .post('/v1/leave/quote')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-17', endDate: '2026-08-21', portion: 'FULL', kind: 'UNPAID', reason: 'x' });
    expect(res.body.chargedDays).toBe(0);
  });
});

describe('request lifecycle', () => {
  it('submitting then approving draws exactly the quoted amount', async () => {
    const u = await seedAdminWithShift();
    const before = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    const startBalance = before.body.balance.balanceDays;

    const submitted = await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-17', endDate: '2026-08-17', portion: 'FIRST_HALF', kind: 'PAID', reason: 'exam' });
    expect(submitted.status).toBe(201);
    expect(submitted.body.chargedDays).toBe(0.5);
    expect(submitted.body.status).toBe('PENDING');

    // Pending draws nothing.
    const mid = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    expect(mid.body.balance.balanceDays).toBe(startBalance);

    const other = await seedUser({ role: 'ADMIN' });
    void other;
    const decided = await request(app)
      .post(`/v1/admin/leave/requests/${submitted.body.id}/decide`)
      .set(auth(u.accessToken))
      .send({ decision: 'APPROVE' });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe('APPROVED');

    const after = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    expect(after.body.balance.balanceDays).toBe(startBalance - 0.5);
  });

  it('approving twice charges once', async () => {
    const u = await seedAdminWithShift();
    const before = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    const start = before.body.balance.balanceDays;

    const r = await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-17', endDate: '2026-08-17', reason: 'x' });

    await request(app)
      .post(`/v1/admin/leave/requests/${r.body.id}/decide`)
      .set(auth(u.accessToken))
      .send({ decision: 'APPROVE' })
      .expect(200);
    // A replayed decision — Lark can deliver the same one twice.
    await request(app)
      .post(`/v1/admin/leave/requests/${r.body.id}/decide`)
      .set(auth(u.accessToken))
      .send({ decision: 'APPROVE' })
      .expect(200);

    const after = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    expect(after.body.balance.balanceDays).toBe(start - 1);
    const consumptions = await prisma.leaveLedgerEntry.count({
      where: { userId: u.userId, kind: 'CONSUMPTION' },
    });
    expect(consumptions).toBe(1);
  });

  it('cancelling an approved request gives the days back as a visible reversal', async () => {
    const u = await seedAdminWithShift();
    const before = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    const start = before.body.balance.balanceDays;

    const r = await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-17', endDate: '2026-08-17', reason: 'x' });
    await request(app)
      .post(`/v1/admin/leave/requests/${r.body.id}/decide`)
      .set(auth(u.accessToken))
      .send({ decision: 'APPROVE' })
      .expect(200);

    await request(app)
      .post(`/v1/leave/requests/${r.body.id}/cancel`)
      .set(auth(u.accessToken))
      .expect(200);

    const after = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    expect(after.body.balance.balanceDays).toBe(start);
    // Given back by a reversing entry, not by deleting the charge.
    const kinds = await prisma.leaveLedgerEntry.findMany({
      where: { requestId: r.body.id },
      select: { kind: true, days: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(kinds.map((k) => k.kind)).toEqual(['CONSUMPTION', 'ADJUSTMENT']);
    expect(kinds[0]!.days).toBe(-1);
    expect(kinds[1]!.days).toBe(1);
  });

  it('rejects a request the balance cannot cover', async () => {
    const u = await seedAdminWithShift();
    // Drain the balance to zero with an adjustment.
    const bal = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    await request(app)
      .post('/v1/admin/leave/adjust')
      .set(auth(u.accessToken))
      .send({
        userId: u.userId,
        days: -bal.body.balance.balanceDays,
        effectiveOn: '2026-01-01',
        reason: 'zero it out',
      })
      .expect(201);

    const r = await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-17', endDate: '2026-08-21', reason: 'x' });
    expect(r.status).toBe(201);

    const decided = await request(app)
      .post(`/v1/admin/leave/requests/${r.body.id}/decide`)
      .set(auth(u.accessToken))
      .send({ decision: 'APPROVE' });
    expect(decided.status).toBe(400);
    expect(decided.body.error).toBe('insufficient_balance');
  });

  it('refuses a second request overlapping an existing one', async () => {
    const u = await seedAdminWithShift();
    await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-17', endDate: '2026-08-18', reason: 'x' })
      .expect(201);

    const clash = await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-18', endDate: '2026-08-19', reason: 'y' });
    expect(clash.status).toBe(400);
    expect(clash.body.error).toBe('overlapping_request');
  });

  it('refuses a request that covers no working day at all', async () => {
    const u = await seedAdminWithShift();
    const res = await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-22', endDate: '2026-08-23', reason: 'weekend' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_working_days');
  });

  it('resubmitting the same clientUuid returns the original request', async () => {
    const u = await seedAdminWithShift();
    const body = { startDate: '2026-08-17', endDate: '2026-08-17', reason: 'x', clientUuid: 'fixed-uuid-1' };
    const a = await request(app).post('/v1/leave/requests').set(auth(u.accessToken)).send(body);
    const b = await request(app).post('/v1/leave/requests').set(auth(u.accessToken)).send(body);
    expect(a.body.id).toBe(b.body.id);
    expect(await prisma.leaveRequest.count({ where: { userId: u.userId } })).toBe(1);
  });

  it('a rejected request costs nothing', async () => {
    const u = await seedAdminWithShift();
    const before = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    const r = await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-17', endDate: '2026-08-17', reason: 'x' });
    await request(app)
      .post(`/v1/admin/leave/requests/${r.body.id}/decide`)
      .set(auth(u.accessToken))
      .send({ decision: 'REJECT', note: 'busy week' })
      .expect(200);

    const after = await request(app).get('/v1/leave/me/balance').set(auth(u.accessToken));
    expect(after.body.balance.balanceDays).toBe(before.body.balance.balanceDays);
    expect(await prisma.leaveLedgerEntry.count({ where: { userId: u.userId, kind: 'CONSUMPTION' } })).toBe(0);
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

    const r = await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-17', endDate: '2026-08-17', portion: 'SECOND_HALF', reason: 'x' });
    await request(app)
      .post(`/v1/admin/leave/requests/${r.body.id}/decide`)
      .set(auth(u.accessToken))
      .send({ decision: 'APPROVE' })
      .expect(200);

    const cal = await request(app)
      .get('/v1/leave/calendar?from=2026-08-15&to=2026-08-25')
      .set(auth(u.accessToken));
    expect(cal.status).toBe(200);
    expect(cal.body.holidays.map((h: { name: string }) => h.name)).toEqual(['Holi']);
    expect(cal.body.away[u.userId]).toEqual([
      { date: '2026-08-17', kind: 'PAID_LEAVE', portion: 'SECOND_HALF', label: 'Paid leave' },
    ]);
  });
});



describe('a person with no shift assigned', () => {
  async function seedWithoutShift() {
    const u = await seedUser({ role: 'ADMIN' });
    await prisma.workspace.update({
      where: { id: u.workspaceId },
      data: { timezone: 'Asia/Kolkata' },
    });
    await prisma.user.update({
      where: { id: u.userId },
      data: { joinedOn: new Date('2026-01-01T00:00:00Z') },
    });
    return u; // deliberately no shift + no assignment
  }

  it('is told their shift is missing, not to pick another day', async () => {
    const u = await seedWithoutShift();
    // A Monday — this fails for the shift, not for the date.
    const res = await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-24', endDate: '2026-08-24', reason: 'test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_shift_assigned');
  });

  it('quotes every day as NO_SHIFT so the UI can block before submitting', async () => {
    const u = await seedWithoutShift();
    const q = await request(app)
      .post('/v1/leave/quote')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-24', endDate: '2026-08-26', reason: 'test' });

    expect(q.status).toBe(200);
    expect(q.body.chargedDays).toBe(0);
    expect(q.body.days.every((d: { kind: string }) => d.kind === 'NO_SHIFT')).toBe(true);
  });

  it('still says no_working_days when the shift exists but the dates are a weekend', async () => {
    const u = await seedAdminWithShift();
    const res = await request(app)
      .post('/v1/leave/requests')
      .set(auth(u.accessToken))
      .send({ startDate: '2026-08-22', endDate: '2026-08-23', reason: 'weekend' });

    expect(res.status).toBe(400);
    // The distinction that matters: this one IS the person's to fix.
    expect(res.body.error).toBe('no_working_days');
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
