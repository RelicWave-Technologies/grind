import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { loadMonthPerformanceReport, reconcileMonthRules, resolveReportMonth } from '../src/reports/monthPerformanceData';
import { payableDays, sheetCode, sheetWhy } from '../src/reports/monthPerformance';
import { loadBalances } from '../src/leave/repository';
import { ATTENDANCE_RULE_LABEL } from '@grind/types';

/**
 * The attendance rules end to end: tracked time, punches, Lark leave and WFH go
 * in; the month report's codes, its Remark row, the exceptions list and the
 * leave ledger come out — and all four have to agree.
 *
 * September 2026, Asia/Kolkata, Monday-to-Saturday shift. "Now" is 3 October,
 * so every September day is in the past and judged.
 */

const app = buildApp();
const NOW = Date.parse('2026-10-03T06:00:00Z');

const SIX_DAY = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: { start: '09:00', end: '18:00' },
  sun: null,
};

/**
 * Hours of work on a date, starting at an IST wall clock (09:00 by default —
 * on time for the 09:00 shift). Lateness is judged on this first tracked
 * activity, not on the punch.
 */
async function work(userId: string, date: string, hours: number, startIst = '09:00') {
  const [h, m] = startIst.split(':').map(Number) as [number, number];
  const startedAt = new Date(Date.parse(`${date}T00:00:00Z`) + ((h * 60 + m) - 330) * 60_000);
  const endedAt = new Date(startedAt.getTime() + hours * 3_600_000);
  await prisma.timeEntry.create({
    data: {
      id: ulid(),
      clientUuid: ulid(),
      userId,
      source: 'AUTO',
      startedAt,
      endedAt,
      agentVersion: '0.0.0',
      platform: 'test',
      segments: { create: [{ id: ulid(), kind: 'WORK', startedAt, endedAt }] },
    },
  });
}

async function punch(workspaceId: string, userId: string, date: string) {
  await prisma.attendancePunch.create({
    data: {
      workspaceId,
      userId,
      date: new Date(`${date}T00:00:00Z`),
      punchInAt: new Date('1970-01-01T09:55:00Z'),
      punchOutAt: new Date('1970-01-01T18:05:00Z'),
    },
  });
}

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ws = await prisma.workspace.create({ data: { name: `EMIAC ${stamp}`, timezone: 'Asia/Kolkata' } });
  await prisma.leavePolicy.create({
    data: { workspaceId: ws.id, attendanceRulesFrom: '2026-09-01', ledgerStartMonth: '2026-09' },
  });
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Technical' } });
  const mk = (label: string, role: 'ADMIN' | 'MEMBER') =>
    prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `${label}-${stamp}@test.local`,
        name: label,
        role,
        teamId: team.id,
        passwordHash: 'x'.repeat(60),
        joinedOn: new Date('2026-01-01T00:00:00Z'),
      },
    });
  const admin = await mk('admin', 'ADMIN');
  const member = await mk('member', 'MEMBER');
  const shift = await prisma.shift.create({ data: { workspaceId: ws.id, name: 'General', schedule: SIX_DAY } });
  await prisma.shiftAssignment.create({
    data: {
      userId: member.id,
      shiftId: shift.id,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      shiftNameSnapshot: shift.name,
      scheduleSnapshot: SIX_DAY,
    },
  });
  // One day of balance for September, nothing else.
  await prisma.leaveLedgerEntry.create({
    data: {
      workspaceId: ws.id,
      userId: member.id,
      kind: 'ACCRUAL',
      days: 1,
      effectiveOn: new Date('2026-09-01T00:00:00Z'),
      sourceKey: `accrual:${member.id}:2026-09`,
    },
  });
  return { ws, admin, member, adminToken: signAccessToken({ sub: admin.id, ws: ws.id, role: 'ADMIN' }) };
}

/**
 * Reconcile the rules (what the scheduler does) and read the month. Reading
 * alone never writes the ledger — see 'the month report is read-only'.
 */
async function september(s: Awaited<ReturnType<typeof seed>>) {
  const range = resolveReportMonth({ month: '2026-09' }, 'Asia/Kolkata');
  if ('error' in range) throw new Error(range.error);
  await reconcileMonthRules({ workspaceId: s.ws.id, userIds: [s.member.id], range, nowMs: NOW });
  const report = await loadMonthPerformanceReport({
    workspaceId: s.ws.id,
    userIds: [s.member.id],
    range,
    nowMs: NOW,
  });
  const row = report.rows[0]!;
  const day = (date: string) => row.days.find((d) => d.date === date)!;
  return { report, row, day };
}

async function ruleLines(userId: string) {
  const rows = await prisma.leaveLedgerEntry.findMany({
    where: { userId, sourceKey: { startsWith: 'rule:' } },
    orderBy: { effectiveOn: 'asc' },
  });
  return new Map(rows.map((r) => [r.effectiveOn.toISOString().slice(0, 10), r.days]));
}

/** A week where every rule fires once, Tue 1 – Tue 8 September. */
async function seedWeek(s: Awaited<ReturnType<typeof seed>>) {
  const { ws, member, admin } = s;
  // Full day at the office, started late (09:55 against 09:00 + 30 min grace).
  await work(member.id, '2026-09-01', 8, '09:55');
  await punch(ws.id, member.id, '2026-09-01');
  // Short day: 5 h.
  await work(member.id, '2026-09-02', 5, '09:55');
  await punch(ws.id, member.id, '2026-09-02');
  // Under half a day: 2 h.
  await work(member.id, '2026-09-03', 2, '09:55');
  await punch(ws.id, member.id, '2026-09-03');
  // A full day from home, no request. Somebody else punched, so the import ran.
  await work(member.id, '2026-09-04', 8);
  await punch(ws.id, admin.id, '2026-09-04');
  // A full day from home with an approved request.
  await work(member.id, '2026-09-05', 8);
  await punch(ws.id, admin.id, '2026-09-05');
  await prisma.wfhRequest.create({
    data: {
      workspaceId: ws.id,
      userId: member.id,
      startDate: new Date('2026-09-05T00:00:00Z'),
      endDate: new Date('2026-09-05T00:00:00Z'),
      reason: 'Plumber',
      status: 'APPROVED',
      larkInstanceCode: `wfh-${ulid()}`,
    },
  });
  // 7 Sep: absent, nothing applied for. 8 Sep: absent, leave still pending.
  await prisma.leaveRequest.create({
    data: {
      clientUuid: ulid(),
      workspaceId: ws.id,
      userId: member.id,
      startDate: new Date('2026-09-08T00:00:00Z'),
      endDate: new Date('2026-09-08T00:00:00Z'),
      reason: 'Fever',
      status: 'PENDING',
    },
  });
}

describe('attendance rules — the month report', () => {
  it('judges each day and draws the leave from the balance in date order', async () => {
    const s = await seed();
    await seedWeek(s);
    const { day, row, report } = await september(s);

    expect(report.rulesFrom).toBe('2026-09-01');
    expect(day('2026-09-01')).toMatchObject({ code: 'P', rule: null });
    // The one day of balance pays the short day's half, then half of the next.
    expect(day('2026-09-02')).toMatchObject({ code: 'PL_HD', rule: { tag: 'SHORT_DAY', penaltyDays: 0.5 } });
    expect(day('2026-09-03')).toMatchObject({ code: 'PL_HD/LWP_HD', rule: { tag: 'UNDER_MIN', penaltyDays: 1 } });
    expect(day('2026-09-04')).toMatchObject({ code: 'LWP', rule: { tag: 'WFH_UNAPPROVED', penaltyDays: 1 } });
    expect(day('2026-09-05')).toMatchObject({ code: 'P', rule: null });
    expect(day('2026-09-06')).toMatchObject({ code: 'WO', rule: null });
    expect(day('2026-09-07')).toMatchObject({ code: 'LWP', rule: { tag: 'NO_APPLICATION' } });
    expect(day('2026-09-08')).toMatchObject({ code: 'LWP', rule: { tag: 'LEAVE_NOT_APPROVED' } });

    expect(row.totals.shortDay).toBe(1);
    expect(row.totals.underMin).toBe(1);
    expect(row.totals.wfhUnapproved).toBe(1);
    // 7 and 8 September plus every later working day nobody worked.
    expect(row.totals.leaveWithoutApproval).toBeGreaterThanOrEqual(2);

    const lines = await ruleLines(s.member.id);
    expect(lines.get('2026-09-02')).toBe(-0.5);
    expect(lines.get('2026-09-03')).toBe(-1);
    expect(lines.get('2026-09-04')).toBe(-1);
    expect(lines.has('2026-09-01')).toBe(false);
    expect(lines.has('2026-09-05')).toBe(false);
    expect(lines.has('2026-09-06')).toBe(false);

    // The balance really moved: one day granted, every rule day charged.
    const charged = [...lines.values()].reduce((sum, d) => sum + d, 0);
    const balance = (await loadBalances([s.member.id], '2026-09-30'))[s.member.id]!;
    expect(balance.balanceDays).toBe(1 + charged);
  });

  it('follows the facts when they change: a late approval removes the charge', async () => {
    const s = await seed();
    await seedWeek(s);
    await september(s);
    expect((await ruleLines(s.member.id)).get('2026-09-04')).toBe(-1);

    await prisma.wfhRequest.create({
      data: {
        workspaceId: s.ws.id,
        userId: s.member.id,
        startDate: new Date('2026-09-04T00:00:00Z'),
        endDate: new Date('2026-09-04T00:00:00Z'),
        reason: 'Approved late',
        status: 'APPROVED',
        larkInstanceCode: `wfh-${ulid()}`,
      },
    });
    const { day } = await september(s);
    expect(day('2026-09-04')).toMatchObject({ code: 'P', rule: null });
    expect((await ruleLines(s.member.id)).has('2026-09-04')).toBe(false);
  });

  it('charges nothing while the rules are off, and clears what they charged', async () => {
    const s = await seed();
    await seedWeek(s);
    await september(s);
    expect((await ruleLines(s.member.id)).size).toBeGreaterThan(0);

    await prisma.leavePolicy.update({ where: { workspaceId: s.ws.id }, data: { attendanceRulesFrom: null } });
    const { day, report } = await september(s);
    expect(report.rulesFrom).toBeNull();
    expect(day('2026-09-02')).toMatchObject({ code: 'P', rule: null });
    expect(day('2026-09-07')).toMatchObject({ code: 'A', rule: null });
    expect((await ruleLines(s.member.id)).size).toBe(0);
  });

  it('a remote person is not charged for working without a punch, and an exempt one for nothing', async () => {
    const s = await seed();
    await seedWeek(s);
    await september(s);
    expect((await ruleLines(s.member.id)).get('2026-09-04')).toBe(-1);

    const res = await request(app)
      .patch(`/v1/admin/leave/members/${s.member.id}`)
      .set({ Authorization: `Bearer ${s.adminToken}` })
      .send({ attendanceRuleMode: 'REMOTE' });
    expect(res.status).toBe(200);
    expect(res.body.attendanceRuleMode).toBe('REMOTE');

    let { day } = await september(s);
    expect(day('2026-09-04')).toMatchObject({ rule: null });
    // Hours and absence still count for a remote person.
    expect(day('2026-09-02').rule).toMatchObject({ tag: 'SHORT_DAY' });
    expect(day('2026-09-07').rule).toMatchObject({ tag: 'NO_APPLICATION' });

    await prisma.user.update({ where: { id: s.member.id }, data: { attendanceRuleMode: 'EXEMPT' } });
    ({ day } = await september(s));
    expect(day('2026-09-02')).toMatchObject({ code: 'P', rule: null });
    expect((await ruleLines(s.member.id)).size).toBe(0);
  });

  it('a manager correction wins and takes the rule charge with it', async () => {
    const s = await seed();
    await seedWeek(s);
    await september(s);

    const res = await request(app)
      .put('/v1/reports/attendance-override')
      .set({ Authorization: `Bearer ${s.adminToken}` })
      .send({ userId: s.member.id, date: '2026-09-03', code: 'P', reason: 'Was at a client site all day' });
    expect(res.status).toBe(200);
    expect((await ruleLines(s.member.id)).has('2026-09-03')).toBe(false);

    const { day } = await september(s);
    expect(day('2026-09-03')).toMatchObject({ code: 'P', rule: null });
  });
});

describe('attendance rules — the month report is read-only', () => {
  it('a GET of the month never writes the leave ledger; the reconcile does', async () => {
    const s = await seed();
    await seedWeek(s);
    const before = await prisma.leaveLedgerEntry.findMany({ where: { userId: s.member.id }, orderBy: { id: 'asc' } });

    const res = await request(app)
      .get('/v1/reports/month-performance.csv?month=2026-09')
      .set({ Authorization: `Bearer ${s.adminToken}` });
    expect(res.status).toBe(200);
    const range = resolveReportMonth({ month: '2026-09' }, 'Asia/Kolkata');
    if ('error' in range) throw new Error(range.error);
    await loadMonthPerformanceReport({ workspaceId: s.ws.id, userIds: [s.member.id], range, nowMs: NOW });
    const after = await prisma.leaveLedgerEntry.findMany({ where: { userId: s.member.id }, orderBy: { id: 'asc' } });
    expect(after).toEqual(before);
    expect((await ruleLines(s.member.id)).size).toBe(0);

    await reconcileMonthRules({ workspaceId: s.ws.id, userIds: [s.member.id], range, nowMs: NOW });
    expect((await ruleLines(s.member.id)).get('2026-09-02')).toBe(-0.5);
  });
});

describe('attendance rules — late arrivals', () => {
  it('lets four go, charges half a day from the fifth, and cuts a day only once', async () => {
    const s = await seed();
    // Tracked work from 09:55 against a 09:00 shift with the default
    // 30-minute grace: late.
    const lateDays = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-07'];
    for (const date of lateDays) {
      await work(s.member.id, date, 8, '09:55');
      await punch(s.ws.id, s.member.id, date);
    }
    // The 7th late arrival is also a short day: one cut, not two.
    await work(s.member.id, '2026-09-08', 5, '09:55');
    await punch(s.ws.id, s.member.id, '2026-09-08');
    // On time on the 9th: inside the grace.
    await work(s.member.id, '2026-09-09', 8, '09:25');
    await prisma.attendancePunch.create({
      data: {
        workspaceId: s.ws.id,
        userId: s.member.id,
        date: new Date('2026-09-09T00:00:00Z'),
        punchInAt: new Date('1970-01-01T09:25:00Z'),
        punchOutAt: new Date('1970-01-01T18:00:00Z'),
      },
    });

    const { day, row } = await september(s);
    expect(lateDays.map((d) => day(d).late)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(day('2026-09-04')).toMatchObject({ code: 'P', rule: null });
    expect(day('2026-09-05')).toMatchObject({ rule: { tag: 'LATE', penaltyDays: 0.5 } });
    expect(day('2026-09-07')).toMatchObject({ rule: { tag: 'LATE', penaltyDays: 0.5 } });
    expect(day('2026-09-08')).toMatchObject({ late: 7, rule: { tag: 'SHORT_DAY', penaltyDays: 0.5 } });
    expect(day('2026-09-09')).toMatchObject({ late: null, code: 'P', rule: null });
    expect(row.totals.lateDays).toBe(7);
    // The Why row keeps the late count running on a day another rule cut.
    const { report } = await september(s);
    expect(sheetWhy(report, day('2026-09-04'))).toBe('late 4');
    expect(sheetWhy(report, day('2026-09-08'))).toBe('<7h · late 7');

    const lines = await ruleLines(s.member.id);
    expect(lines.get('2026-09-05')).toBe(-0.5);
    expect(lines.get('2026-09-07')).toBe(-0.5);
    expect(lines.get('2026-09-08')).toBe(-0.5);
    expect(lines.has('2026-09-04')).toBe(false);
  });

  it('gives everyone the policy grace, even on a shift whose own buffer is 0', async () => {
    const s = await seed();
    await prisma.shift.updateMany({ where: { workspaceId: s.ws.id }, data: { bufferMin: 0 } });
    await work(s.member.id, '2026-09-01', 8, '09:29');
    await prisma.attendancePunch.create({
      data: {
        workspaceId: s.ws.id,
        userId: s.member.id,
        date: new Date('2026-09-01T00:00:00Z'),
        punchInAt: new Date('1970-01-01T09:29:00Z'),
        punchOutAt: new Date('1970-01-01T18:00:00Z'),
      },
    });
    expect((await september(s)).day('2026-09-01').late).toBeNull();

    await prisma.leavePolicy.update({ where: { workspaceId: s.ws.id }, data: { lateGraceMinutes: 15 } });
    expect((await september(s)).day('2026-09-01').late).toBe(1);
  });

  // From main (#148), adapted to the unified rule: lateness is the first
  // TRACKED activity, so the two days now differ by when work started rather
  // than by the punch. The intent is unchanged — Start reads Late exactly when
  // the rules counted a late arrival.
  it('shows Start as Late on the dashboard exactly when the rule counted a late arrival', async () => {
    const s = await seed();
    // Both days punched at 09:55; only when tracked work started differs.
    await work(s.member.id, '2026-09-01', 8, '09:25');
    await punch(s.ws.id, s.member.id, '2026-09-01');
    await work(s.member.id, '2026-09-02', 8, '09:55');
    await punch(s.ws.id, s.member.id, '2026-09-02');

    const params = new URLSearchParams({ userId: s.member.id, from: '2026-09-01', to: '2026-09-02', tz: 'Asia/Kolkata' });
    const res = await request(app)
      .get(`/v1/reports/team/member?${params.toString()}`)
      .set({ Authorization: `Bearer ${s.adminToken}` });
    expect(res.status).toBe(200);
    const status = (res.body.member.days as Array<{ date: string; shiftStatus: string }>).map((d) => [d.date, d.shiftStatus]);
    expect(status).toEqual([
      ['2026-09-01', 'on_time'],
      ['2026-09-02', 'late'],
    ]);
    expect(res.body.member.lateDays).toBe(1);
    // And the month sheet counted the same one.
    expect((await september(s)).day('2026-09-02').late).toBe(1);
  });

  it('reads Start as on time for a late start the rules do not count (exempt person)', async () => {
    const s = await seed();
    await prisma.user.update({ where: { id: s.member.id }, data: { attendanceRuleMode: 'EXEMPT' } });
    await work(s.member.id, '2026-09-02', 8, '11:00');
    const params = new URLSearchParams({ userId: s.member.id, from: '2026-09-02', to: '2026-09-02' });
    const res = await request(app)
      .get(`/v1/reports/team/member?${params.toString()}`)
      .set({ Authorization: `Bearer ${s.adminToken}` });
    expect(res.status).toBe(200);
    expect(res.body.member.days[0].shiftStatus).toBe('on_time');
    expect(res.body.member.lateDays).toBe(0);
  });

  // From main (#150), on the unified rule: on a first-half leave day the
  // afternoon is due at 14:00, so tracked work starting after it is late — no
  // grace — and Start reads Late on the same day the sheet counts it.
  it('on a first-half leave day counts tracked work starting after 14:00 as late, with no grace', async () => {
    const s = await seed();
    for (const [date, start] of [['2026-09-01', '13:55'], ['2026-09-02', '14:10']] as const) {
      await prisma.leaveRequest.create({
        data: {
          clientUuid: ulid(),
          workspaceId: s.ws.id,
          userId: s.member.id,
          startDate: new Date(`${date}T00:00:00Z`),
          endDate: new Date(`${date}T00:00:00Z`),
          portion: 'FIRST_HALF',
          reason: 'Morning off',
          status: 'APPROVED',
        },
      });
      await work(s.member.id, date, 4, start);
    }

    const { day } = await september(s);
    expect(day('2026-09-01').late).toBeNull();
    expect(day('2026-09-02').late).toBe(1);

    const params = new URLSearchParams({ userId: s.member.id, from: '2026-09-01', to: '2026-09-02', tz: 'Asia/Kolkata' });
    const res = await request(app)
      .get(`/v1/reports/team/member?${params.toString()}`)
      .set({ Authorization: `Bearer ${s.adminToken}` });
    expect(res.status).toBe(200);
    const status = (res.body.member.days as Array<{ date: string; shiftStatus: string }>).map((d) => [d.date, d.shiftStatus]);
    expect(status).toEqual([
      ['2026-09-01', 'on_time'],
      ['2026-09-02', 'late'],
    ]);
  });

  // Production's rule (#150): only a STANDARD person can be late. Remote and
  // exempt people are never counted, and the Start column agrees — rules on
  // or off.
  it('never counts a remote or exempt person late, and Start never says Late for them', async () => {
    const s = await seed();
    await prisma.user.update({ where: { id: s.member.id }, data: { attendanceRuleMode: 'REMOTE' } });
    for (const date of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-07']) {
      await work(s.member.id, date, 8, '09:55');
    }
    const remote = await september(s);
    expect(remote.row.totals.lateDays).toBe(0);
    expect(remote.row.days.filter((d) => d.rule?.tag === 'LATE')).toHaveLength(0);

    const start = async () => {
      const params = new URLSearchParams({ userId: s.member.id, from: '2026-09-01', to: '2026-09-02', tz: 'Asia/Kolkata' });
      const res = await request(app)
        .get(`/v1/reports/team/member?${params.toString()}`)
        .set({ Authorization: `Bearer ${s.adminToken}` });
      expect(res.status).toBe(200);
      return (res.body.member.days as Array<{ shiftStatus: string }>).map((d) => d.shiftStatus);
    };
    expect(await start()).toEqual(['on_time', 'on_time']);
    // With the rules off the label falls back to the core rule — same answer.
    await prisma.leavePolicy.update({ where: { workspaceId: s.ws.id }, data: { attendanceRulesFrom: null } });
    expect(await start()).toEqual(['on_time', 'on_time']);
    await prisma.user.update({ where: { id: s.member.id }, data: { attendanceRuleMode: 'STANDARD' } });
    expect(await start()).toEqual(['late', 'late']);
    await prisma.leavePolicy.update({ where: { workspaceId: s.ws.id }, data: { attendanceRulesFrom: '2026-09-01' } });

    await prisma.user.update({ where: { id: s.member.id }, data: { attendanceRuleMode: 'EXEMPT' } });
    const exempt = await september(s);
    expect(exempt.row.totals.lateDays).toBe(0);
    expect(exempt.row.days.filter((d) => d.rule?.tag === 'LATE')).toHaveLength(0);
  });

  it('never checks a second-half leave day against the shift start', async () => {
    const s = await seed();
    await prisma.leaveRequest.create({
      data: {
        clientUuid: ulid(),
        workspaceId: s.ws.id,
        userId: s.member.id,
        startDate: new Date('2026-09-02T00:00:00Z'),
        endDate: new Date('2026-09-02T00:00:00Z'),
        portion: 'SECOND_HALF',
        reason: 'Errand',
        status: 'APPROVED',
      },
    });
    await work(s.member.id, '2026-09-02', 4, '11:00');
    expect((await september(s)).day('2026-09-02').late).toBeNull();
  });

  it('is never late on leave, holidays or first-half leave; manual time does not start a day', async () => {
    const s = await seed();
    await prisma.companyHoliday.create({ data: { workspaceId: s.ws.id, date: new Date('2026-09-01T00:00:00Z'), name: 'Holiday' } });
    await work(s.member.id, '2026-09-01', 8, '11:00');
    await prisma.leaveRequest.create({
      data: {
        clientUuid: ulid(),
        workspaceId: s.ws.id,
        userId: s.member.id,
        startDate: new Date('2026-09-02T00:00:00Z'),
        endDate: new Date('2026-09-02T00:00:00Z'),
        portion: 'FIRST_HALF',
        reason: 'Dentist',
        status: 'APPROVED',
      },
    });
    await work(s.member.id, '2026-09-02', 4, '14:00');
    // Manual time from 09:00 does not make a 12:00 tracked start on time.
    const manualStart = new Date('2026-09-03T03:30:00Z');
    const manualEnd = new Date('2026-09-03T06:30:00Z');
    await prisma.timeEntry.create({
      data: {
        id: ulid(),
        clientUuid: ulid(),
        userId: s.member.id,
        source: 'MANUAL',
        startedAt: manualStart,
        endedAt: manualEnd,
        segments: { create: [{ id: ulid(), kind: 'WORK', startedAt: manualStart, endedAt: manualEnd }] },
      },
    });
    await work(s.member.id, '2026-09-03', 5, '12:00');
    const { day } = await september(s);
    expect(day('2026-09-01').late).toBeNull();
    expect(day('2026-09-02').late).toBeNull();
    expect(day('2026-09-03').late).toBe(1);
  });
});

describe('attendance rules — a suspended person', () => {
  it('stays on the month they were suspended in, with every later day out of the count', async () => {
    const s = await seed();
    for (const date of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']) {
      await work(s.member.id, date, 8);
      await prisma.attendancePunch.create({
        data: {
          workspaceId: s.ws.id,
          userId: s.member.id,
          date: new Date(`${date}T00:00:00Z`),
          punchInAt: new Date('1970-01-01T09:00:00Z'),
          punchOutAt: new Date('1970-01-01T18:00:00Z'),
        },
      });
    }
    // Suspended the evening of the 10th (IST).
    await prisma.user.update({ where: { id: s.member.id }, data: { deactivatedAt: new Date('2026-09-10T13:00:00Z') } });

    const { day, row } = await september(s);
    expect(day('2026-09-10')).toMatchObject({ code: 'P', rule: null });
    expect(day('2026-09-11')).toMatchObject({ code: '--', rule: null });
    expect(day('2026-09-30')).toMatchObject({ code: '--', rule: null });
    expect(row.days.filter((d) => d.rule)).toHaveLength(0);
    expect(sheetCode(day('2026-09-15'))).toBe('--');
    expect(payableDays({ dates: Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`) }, row)).toBe(10);
    expect((await ruleLines(s.member.id)).size).toBe(0);

    // The admin's export still lists them for September, but not for October.
    const auth = { Authorization: `Bearer ${s.adminToken}` };
    const sept = await request(app).get('/v1/reports/month-performance.csv?month=2026-09').set(auth);
    expect(sept.text).toContain(s.member.email);
    expect(sept.text).toContain('Payable Days,10 of 10');
    const oct = await request(app).get('/v1/reports/month-performance.csv?month=2026-10').set(auth);
    expect(oct.text).not.toContain(s.member.email);
  });
});

describe('attendance rules — HTTP surfaces', () => {
  it('the timesheet CSV keeps charged empty days and drops the charge on a corrected day', async () => {
    const s = await seed();
    await seedWeek(s);
    const auth = { Authorization: `Bearer ${s.adminToken}` };
    const corrected = await request(app)
      .put('/v1/reports/attendance-override')
      .set(auth)
      .send({ userId: s.member.id, date: '2026-09-03', code: 'P', reason: 'Was at a client site all day' });
    expect(corrected.status).toBe(200);

    const res = await request(app).get('/v1/admin/timesheets.csv?from=2026-09-01&to=2026-09-08').set(auth);
    expect(res.status).toBe(200);
    const rows = new Map(
      res.text.trim().split('\n').slice(1)
        .map((line) => line.split(','))
        .filter((cells) => cells[1] === s.member.email)
        .map((cells) => [cells[3], { total: cells[7], remark: cells[12], leave: cells[13] }]),
    );
    // Corrected: the manager's call stands, no rule speaks for the day.
    expect(rows.get('2026-09-03')).toMatchObject({ remark: '', leave: '' });
    // Nothing tracked and nothing applied for: the row the export is for.
    expect(rows.get('2026-09-07')).toEqual({
      total: '0.00',
      remark: ATTENDANCE_RULE_LABEL.NO_APPLICATION,
      leave: '1',
    });
    expect(rows.get('2026-09-08')?.remark).toBe(ATTENDANCE_RULE_LABEL.LEAVE_NOT_APPROVED);
    // A weekly off with no time has nothing to say.
    expect(rows.has('2026-09-06')).toBe(false);
  });

  it('lists the exceptions and prints a Why row in the CSV', async () => {
    const s = await seed();
    await seedWeek(s);
    // The reports read what the reconcile wrote; a GET no longer writes it.
    await september(s);
    const auth = { Authorization: `Bearer ${s.adminToken}` };

    const ex = await request(app).get('/v1/reports/attendance-exceptions?month=2026-09').set(auth);
    expect(ex.status).toBe(200);
    expect(ex.body.rulesFrom).toBe('2026-09-01');
    const tags = (ex.body.exceptions as Array<{ date: string; tag: string }>)
      .filter((e) => e.date <= '2026-09-08')
      .map((e) => `${e.date}:${e.tag}`)
      .sort();
    expect(tags).toEqual([
      '2026-09-02:SHORT_DAY',
      '2026-09-03:UNDER_MIN',
      '2026-09-04:WFH_UNAPPROVED',
      '2026-09-07:NO_APPLICATION',
      '2026-09-08:LEAVE_NOT_APPROVED',
    ]);

    const csv = await request(app).get('/v1/reports/month-performance.csv?month=2026-09').set(auth);
    expect(csv.status).toBe(200);
    const lines = csv.text.split('\n');
    const memberAt = lines.findIndex((l) => l.startsWith('Email,') && l.includes(s.member.email));
    const block = lines.slice(memberAt);
    const status = block.find((l) => l.startsWith('Status,'));
    const why = block.find((l) => l.startsWith('Why,'));
    expect(status?.split(',').slice(1, 9)).toEqual(['P', 'HD', 'L', 'L', 'P', 'WO', 'LWA', 'LWA']);
    // The 1st is a late arrival that costs nothing yet: shown so the count is
    // visible. The 2nd and 3rd were late too, shown beside the hours cut.
    expect(why?.split(',').slice(1, 9)).toEqual(['late 1', '<7h · late 2', '<3.5h · late 3', 'WFH', '', '', 'no leave', 'unapproved']);
    expect(block[0]).toContain('Payable Days');

    const xlsx = await request(app).get('/v1/reports/month-performance.xlsx?month=2026-09').set(auth);
    expect(xlsx.status).toBe(200);

    // The month on one row per person, with the leave account behind it.
    const sum = await request(app).get('/v1/reports/month-summary?month=2026-09').set(auth);
    expect(sum.status).toBe(200);
    const me = (sum.body.rows as Array<Record<string, unknown>>).find((r) => r.email === s.member.email) as {
      present: number; halfDay: number; leave: number; lwa: number; salaryCut: number;
      account: { opening: number; earned: number; paid: number; closing: number; lines: Array<{ kind: string; days: number; paid?: number; code?: string }> };
    };
    expect(me.halfDay).toBe(1);
    expect(me.lwa).toBeGreaterThanOrEqual(2);
    const a = me.account;
    const credits = a.lines.filter((l) => l.kind === 'credit').reduce((x, l) => x + l.days, 0);
    const paid = a.lines.filter((l) => l.kind === 'leave').reduce((x, l) => x + (l.paid ?? 0), 0);
    expect(a.opening + credits - paid).toBe(a.closing);
    expect(a.closing).toBeGreaterThanOrEqual(0);
    expect(a.lines.find((l) => l.kind === 'leave')?.code).toBe('HD');
  });
});
