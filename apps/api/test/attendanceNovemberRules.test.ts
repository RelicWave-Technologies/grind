import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { loadMonthPerformanceReport, reconcileMonthRules, resolveReportMonth } from '../src/reports/monthPerformanceData';
import { sheetWhy } from '../src/reports/monthPerformance';

/**
 * The November 2026 rule changes end to end: the minimums go from 7h / 3h30
 * to 8h / 4h from 21 November without touching earlier days, and the sandwich
 * rule charges a Sunday between a fully-off Saturday and Monday.
 *
 * Asia/Kolkata, Monday-to-Saturday shift. "Now" is 2 December, so every
 * November day is in the past and judged.
 */

const app = buildApp();
const NOW = Date.parse('2026-12-02T06:00:00Z');

const SIX_DAY = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: { start: '09:00', end: '18:00' },
  sun: null,
};

/** Hours of tracked work on a date, starting at an IST wall clock (09:00 by default). */
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

/**
 * A door punch as the eTime import writes it: the IST wall clock stored as a
 * time of day (09:55 by default — late for the 09:00 shift). Lateness is judged
 * on this punch-in, not on when tracked work started.
 */
async function punch(workspaceId: string, userId: string, date: string, inIst = '09:55') {
  await prisma.attendancePunch.create({
    data: {
      workspaceId,
      userId,
      date: new Date(`${date}T00:00:00Z`),
      punchInAt: new Date(`1970-01-01T${inIst}:00Z`),
      punchOutAt: new Date('1970-01-01T18:05:00Z'),
    },
  });
}

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ws = await prisma.workspace.create({ data: { name: `EMIAC ${stamp}`, timezone: 'Asia/Kolkata' } });
  await prisma.leavePolicy.create({
    data: { workspaceId: ws.id, attendanceRulesFrom: '2026-09-01', ledgerStartMonth: '2026-11' },
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
      effectiveOn: new Date('2026-11-01T00:00:00Z'),
      sourceKey: `accrual:${member.id}:2026-11`,
    },
  });
  return { ws, admin, member, adminToken: signAccessToken({ sub: admin.id, ws: ws.id, role: 'ADMIN' }) };
}


async function november(s: Awaited<ReturnType<typeof seed>>) {
  const range = resolveReportMonth({ month: '2026-11' }, 'Asia/Kolkata');
  if ('error' in range) throw new Error(range.error);
  await reconcileMonthRules({ workspaceId: s.ws.id, userIds: [s.member.id], range, nowMs: NOW });
  const report = await loadMonthPerformanceReport({ workspaceId: s.ws.id, userIds: [s.member.id], range, nowMs: NOW });
  const row = report.rows[0]!;
  const day = (date: string) => row.days.find((d) => d.date === date)!;
  const lines = await prisma.leaveLedgerEntry.findMany({
    where: { userId: s.member.id, sourceKey: { startsWith: 'rule:' } },
  });
  const line = (date: string) => lines.find((l) => l.effectiveOn.toISOString().slice(0, 10) === date)?.days ?? null;
  return { report, day, line };
}

/** A full office day: punched in on time, `hours` tracked. */
async function officeDay(s: Awaited<ReturnType<typeof seed>>, date: string, hours: number) {
  await work(s.member.id, date, hours, '09:05');
  await punch(s.ws.id, s.member.id, date, '09:05');
}

describe('November 2026 rules — 8h / 4h from a date, and the sandwich rule', () => {
  it('judges days before the change on 7h / 3h30 and from it on 8h / 4h', async () => {
    const s = await seed();
    await officeDay(s, '2026-11-18', 3.75); // 3h45: half day under either pair
    await officeDay(s, '2026-11-19', 7.5); //  7h30: full day before the change
    await officeDay(s, '2026-11-20', 3.75);
    await officeDay(s, '2026-11-24', 7.5); //  7h30: half day from the change
    await officeDay(s, '2026-11-25', 3.75); // 3h45: under 4h, a full leave
    await officeDay(s, '2026-11-26', 8); //    exactly 8h: full day

    const res = await request(app)
      .patch('/v1/admin/leave/policy')
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ fullDayMinMinutes: 480, halfDayMinMinutes: 240, minimumsFrom: '2026-11-21' });
    expect(res.status).toBe(200);
    expect(res.body.fullDayMinMinutes).toBe(480);
    expect(res.body.minimumsHistory).toEqual([{ until: '2026-11-21', fullDayMinMinutes: 420, halfDayMinMinutes: 210 }]);

    const { day, line, report } = await november(s);
    expect(day('2026-11-18').rule).toMatchObject({ tag: 'SHORT_DAY', minMinutes: 420 });
    expect(sheetWhy(report, day('2026-11-18'))).toBe('<7h');
    expect(day('2026-11-19').rule).toBeNull();
    expect(line('2026-11-19')).toBeNull();
    expect(day('2026-11-24').rule).toMatchObject({ tag: 'SHORT_DAY', minMinutes: 480 });
    expect(sheetWhy(report, day('2026-11-24'))).toBe('<8h');
    expect(line('2026-11-24')).toBe(-0.5);
    expect(day('2026-11-25').rule).toMatchObject({ tag: 'UNDER_MIN', minMinutes: 240 });
    expect(sheetWhy(report, day('2026-11-25'))).toBe('<4h');
    expect(day('2026-11-26').rule).toBeNull();
    expect(report.ruleMinutes).toMatchObject({
      fullDay: 480,
      halfDay: 240,
      minimumsChange: { from: '2026-11-21', fullDay: 420, halfDay: 210 },
    });
  });

  it('refuses new minimums that start before the last change', async () => {
    const s = await seed();
    const auth = { Authorization: `Bearer ${s.adminToken}` };
    await request(app).patch('/v1/admin/leave/policy').set(auth)
      .send({ fullDayMinMinutes: 480, halfDayMinMinutes: 240, minimumsFrom: '2026-11-21' });
    const res = await request(app).patch('/v1/admin/leave/policy').set(auth)
      .send({ fullDayMinMinutes: 450, minimumsFrom: '2026-11-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('minimums_from_before_last_change');
  });

  it('charges the Sunday between an absent Saturday and Monday, and only then', async () => {
    const s = await seed();
    // Every November working day is worked in full unless left out below.
    const skip = new Set(['2026-11-14', '2026-11-16', '2026-11-21', '2026-11-23', '2026-11-28']);
    for (let d = 2; d <= 30; d++) {
      const date = `2026-11-${String(d).padStart(2, '0')}`;
      if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0 || skip.has(date)) continue;
      await officeDay(s, date, 8.5);
    }
    // Monday 23: approved paid leave — still a day away.
    await prisma.leaveRequest.create({
      data: {
        clientUuid: ulid(),
        workspaceId: s.ws.id,
        userId: s.member.id,
        kind: 'PAID',
        status: 'APPROVED',
        portion: 'FULL',
        startDate: new Date('2026-11-23T00:00:00Z'),
        endDate: new Date('2026-11-23T00:00:00Z'),
        chargedDays: 1,
        reason: 'Family',
      },
    });
    const res = await request(app)
      .patch('/v1/admin/leave/policy')
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ sandwichRuleFrom: '2026-11-21' });
    expect(res.status).toBe(200);
    expect(res.body.sandwichRuleFrom).toBe('2026-11-21');

    const { day, line, report } = await november(s);
    // Sat 21 absent + Mon 23 on leave → Sunday 22 is leave.
    expect(day('2026-11-22').rule).toEqual({ tag: 'SANDWICH', penaltyDays: 1 });
    expect(line('2026-11-22')).toBe(-1);
    expect(sheetWhy(report, day('2026-11-22'))).toBe('sandwich');
    expect(['PL', 'LWP']).toContain(day('2026-11-22').code);
    // Sat 14 + Mon 16 both absent, but before the rule started.
    expect(day('2026-11-15').rule).toBeNull();
    // Sat 28 absent, Mon 30 worked → Sunday 29 untouched.
    expect(day('2026-11-29').rule).toBeNull();
    expect(line('2026-11-29')).toBeNull();
    expect(day('2026-11-29').code).toBe('WO');
  });

  it('spends the leave balance on the sandwich Sunday', async () => {
    const s = await seed();
    await prisma.leavePolicy.update({ where: { workspaceId: s.ws.id }, data: { sandwichRuleFrom: '2026-11-21' } });
    // Only the weekend 21–23 is missed; the 1 day of balance pays the first charge.
    for (let d = 2; d <= 30; d++) {
      const date = `2026-11-${String(d).padStart(2, '0')}`;
      if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0 || date === '2026-11-21' || date === '2026-11-23') continue;
      await officeDay(s, date, 8.5);
    }
    const { day } = await november(s);
    // 21 → paid from the one day of balance; 22 (sandwich) and 23 → unpaid.
    expect(day('2026-11-21').code).toBe('PL');
    expect(day('2026-11-22').code).toBe('LWP');
    expect(day('2026-11-23').code).toBe('LWP');
  });

  it('reaches across the month end: a Sunday on the 1st is judged by the Saturday before', async () => {
    const s = await seed();
    await prisma.leavePolicy.update({ where: { workspaceId: s.ws.id }, data: { sandwichRuleFrom: '2026-10-01' } });
    // Sat 31 Oct absent (October unworked), Sun 1 Nov, Mon 2 Nov absent.
    const { day } = await november(s);
    expect(day('2026-11-01').rule).toEqual({ tag: 'SANDWICH', penaltyDays: 1 });
  });
});
