import { prisma } from '@grind/db';
import { instantForLocalMinute } from '@grind/core';
import {
  dateKeyInTimeZone,
  type AttendanceRuleMode,
  type AttendanceRuleVerdict,
  type DayStatus,
} from '@grind/types';
import { leaveDateRange } from '../leave/workingCalendar';
import { loadOrCreateLeavePolicy, loadWorkingCalendar } from '../leave/repository';
import { loadPunchLookup, type PunchLookup } from './punches';
import { isLateArrival, judgeDay, withLateRule, type AttendanceRulePolicy } from './rules';
import { loadDayFacts } from '../time';

/**
 * Everything the attendance rules need beyond the calendar and the hours,
 * loaded once for a set of people over a range: the policy, which dates the
 * punch import covers, approved work-from-home, leave that was applied for but
 * not approved, the door punches, and each person's late arrivals (by punch-in)
 * counted from the start of the month.
 *
 * The rows are read here and the decision is made in `rules.ts`, so the rules
 * themselves stay testable without a database.
 */
export interface AttendanceRuleContext {
  policy: AttendanceRulePolicy & { lateAllowedPerMonth: number; lateGraceMinutes: number; halfDayLateAfterMinute: number };
  /** Whether the rules can judge anything at all. */
  enabled: boolean;
  judge: (userId: string, date: string, status: DayStatus | null, trackedMinutes: number) => AttendanceRuleVerdict | null;
  /** 1 for the month's first late arrival, 2 for the second…; null when on time. */
  lateOrdinalFor: (userId: string, date: string) => number | null;
  /**
   * How the rules treat a person, loaded even while the rules are off: the
   * Start column's Late label follows the same mode rule as the count.
   */
  modeFor: (userId: string) => AttendanceRuleMode;
  /**
   * The door punches the late count was judged on, from the start of the
   * month on, loaded even while the rules are off. The reports print and label
   * from this same lookup, so the Punch in column, the Start label and the
   * late count read one record.
   */
  punchFor: PunchLookup;
}

export async function loadAttendanceRuleContext(input: {
  workspaceId: string;
  tz: string;
  userIds: string[];
  from: string;
  to: string;
  nowMs?: number;
}): Promise<AttendanceRuleContext> {
  const leavePolicy = await loadOrCreateLeavePolicy(input.workspaceId);
  const policy = {
    from: leavePolicy.attendanceRulesFrom ?? null,
    fullDayMinMinutes: leavePolicy.fullDayMinMinutes,
    halfDayMinMinutes: leavePolicy.halfDayMinMinutes,
    wfhRequiresApproval: leavePolicy.wfhRequiresApproval,
    lateAllowedPerMonth: leavePolicy.lateAllowedPerMonth,
    lateGraceMinutes: leavePolicy.lateGraceMinutes,
    halfDayLateAfterMinute: leavePolicy.halfDayLateAfterMinute,
  };
  // Late arrivals are counted per calendar month, so the count for a day in the
  // middle of the range needs every day since its month began.
  const monthStart = `${input.from.slice(0, 7)}-01`;
  const [people, punchFor] = await Promise.all([
    input.userIds.length === 0
      ? []
      : prisma.user.findMany({
          where: { id: { in: input.userIds } },
          select: { id: true, attendanceRuleMode: true },
        }),
    loadPunchLookup({ userIds: input.userIds, from: monthStart, to: input.to }),
  ]);
  const modeOf = new Map(people.map((p) => [p.id, p.attendanceRuleMode]));
  const modeFor = (userId: string): AttendanceRuleMode => modeOf.get(userId) ?? 'STANDARD';
  if (!policy.from || policy.from > input.to || input.userIds.length === 0) {
    return { policy, enabled: false, judge: () => null, lateOrdinalFor: () => null, modeFor, punchFor };
  }

  const fromDate = new Date(`${input.from}T00:00:00Z`);
  const toDate = new Date(`${input.to}T00:00:00Z`);
  const overlap = { startDate: { lte: toDate }, endDate: { gte: fromDate } };
  const lateFrom = monthStart > policy.from ? monthStart : policy.from;

  const [coveredDates, wfh, unapprovedLeave, calendar, overrides] = await Promise.all([
    prisma.attendancePunch.groupBy({
      by: ['date'],
      where: { workspaceId: input.workspaceId, date: { gte: fromDate, lte: toDate } },
    }),
    prisma.wfhRequest.findMany({
      where: { workspaceId: input.workspaceId, userId: { in: input.userIds }, status: 'APPROVED', ...overlap },
      select: { userId: true, startDate: true, endDate: true },
    }),
    prisma.leaveRequest.findMany({
      where: {
        workspaceId: input.workspaceId,
        userId: { in: input.userIds },
        status: { in: ['PENDING', 'REJECTED'] },
        ...overlap,
      },
      select: { userId: true, startDate: true, endDate: true },
    }),
    loadWorkingCalendar({ workspaceId: input.workspaceId, tz: input.tz, userIds: input.userIds, from: lateFrom, to: input.to }),
    prisma.attendanceOverride.findMany({
      where: {
        userId: { in: input.userIds },
        date: { gte: new Date(`${lateFrom}T00:00:00Z`), lte: toDate },
      },
      select: { userId: true, date: true },
    }),
  ]);

  const coverage = new Set(coveredDates.map((r) => r.date.toISOString().slice(0, 10)));
  const ranges = (rows: Array<{ userId: string; startDate: Date; endDate: Date }>) => {
    const byUser = new Map<string, Array<[string, string]>>();
    for (const r of rows) {
      const list = byUser.get(r.userId) ?? [];
      list.push([r.startDate.toISOString().slice(0, 10), r.endDate.toISOString().slice(0, 10)]);
      byUser.set(r.userId, list);
    }
    return (userId: string, date: string) =>
      (byUser.get(userId) ?? []).some(([s, e]) => date >= s && date <= e);
  };
  const wfhApproved = ranges(wfh);
  const leaveApplied = ranges(unapprovedLeave);
  const today = dateKeyInTimeZone(new Date(input.nowMs ?? Date.now()), input.tz);

  // Late arrivals, numbered within each month in date order: the door punch-in
  // against the shift assigned for that date, one grace for everyone (on a
  // first-half leave day, the policy's afternoon time instead).
  const dates = input.to < lateFrom ? [] : leaveDateRange(lateFrom, input.to, 400);
  const facts = dates.length === 0
    ? null
    : await loadDayFacts({
        userIds: input.userIds,
        from: lateFrom,
        to: input.to,
        tz: input.tz,
        calendar: { dayStatusFor: (userId, date) => calendar.dayStatus(userId, date) },
        punchFor,
      });
  const overridden = new Set(overrides.map((o) => `${o.userId}|${o.date.toISOString().slice(0, 10)}`));

  const lateOrdinal = new Map<string, number>();
  for (const userId of input.userIds) {
    let month = '';
    let count = 0;
    for (const date of dates) {
      if (date.slice(0, 7) !== month) {
        month = date.slice(0, 7);
        count = 0;
      }
      if (date >= today) break;
      const key = `${userId}|${date}`;
      // A corrected day is the corrector's call, lateness included.
      if (overridden.has(key)) continue;
      const day = facts!.factsFor(userId, date);
      const late = isLateArrival({
        status: day.status,
        mode: modeFor(userId),
        punchInMs: day.punchInMs,
        shiftStartMs: day.shift?.startMs ?? null,
        graceMinutes: policy.lateGraceMinutes,
        halfDayLateAfterMs: instantForLocalMinute(date, policy.halfDayLateAfterMinute, input.tz),
      });
      if (late) {
        count += 1;
        lateOrdinal.set(key, count);
      }
    }
  }
  const lateOrdinalFor = (userId: string, date: string) => lateOrdinal.get(`${userId}|${date}`) ?? null;

  return {
    policy,
    enabled: true,
    lateOrdinalFor,
    modeFor,
    punchFor,
    judge: (userId, date, status, trackedMinutes) => {
      const punch = punchFor(userId, date);
      const base = judgeDay(policy, {
        date,
        today,
        status,
        trackedMinutes,
        punched: punch !== null && (punch.inMinute !== null || punch.outMinute !== null),
        punchCoverage: coverage.has(date),
        wfhApproved: wfhApproved(userId, date),
        leaveApplied: leaveApplied(userId, date),
        mode: modeFor(userId),
      });
      if (!policy.from || date < policy.from || date >= today) return base;
      return withLateRule(base, lateOrdinalFor(userId, date), policy.lateAllowedPerMonth);
    },
  };
}

/** The late lookup the member report reads, or undefined when the rules are off. */
export function lateLookup(rules: AttendanceRuleContext): { from: string; ordinalFor: (userId: string, date: string) => number | null } | undefined {
  return rules.enabled && rules.policy.from ? { from: rules.policy.from, ordinalFor: rules.lateOrdinalFor } : undefined;
}
