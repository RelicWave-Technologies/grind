import { prisma } from '@grind/db';
import { instantForLocalMinute } from '@grind/core';
import {
  addDays,
  dateKeyInTimeZone,
  minimumsOn,
  parseMinimumsHistory,
  weekdayForDate,
  type AttendanceMinimumsEra,
  type AttendanceRuleMode,
  type AttendanceRuleVerdict,
  type DayStatus,
} from '@grind/types';
import { leaveDateRange } from '../leave/workingCalendar';
import { loadApprovedWfh, loadOrCreateLeavePolicy, loadWorkingCalendar } from '../leave/repository';
import { loadPunchLookup, type PunchLookup } from './punches';
import {
  isLateArrival,
  judgeDay,
  judgeSandwich,
  withLateRule,
  type AttendanceRulePolicy,
  type SandwichOverrideCode,
} from './rules';
import { dayFactsFrom, loadDayFactAssignments, loadTimeline } from '../time';

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
  policy: AttendanceRulePolicy & {
    lateAllowedPerMonth: number;
    lateGraceMinutes: number;
    halfDayLateAfterMinute: number;
    /** Earlier minimums; `fullDayMinMinutes` / `halfDayMinMinutes` are today's. */
    minimumsHistory: AttendanceMinimumsEra[];
    /** First date the sandwich rule judges, or null when it is off. */
    sandwichFrom: string | null;
  };
  /** Whether the rules can judge anything at all. */
  enabled: boolean;
  /**
   * The verdict for one person-day. `minutesOn` gives the same person's tracked
   * minutes on another date of the caller's range: the sandwich rule judges a
   * Sunday by its Saturday and Monday. Without it, no Sunday is charged.
   */
  judge: (
    userId: string,
    date: string,
    status: DayStatus | null,
    trackedMinutes: number,
    minutesOn?: (date: string) => number,
  ) => AttendanceRuleVerdict | null;
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
    minimumsHistory: parseMinimumsHistory(leavePolicy.minimumsHistory),
    sandwichFrom: leavePolicy.sandwichRuleFrom ?? null,
    wfhRequiresApproval: leavePolicy.wfhRequiresApproval,
    lateAllowedPerMonth: leavePolicy.lateAllowedPerMonth,
    lateGraceMinutes: leavePolicy.lateGraceMinutes,
    halfDayLateAfterMinute: leavePolicy.halfDayLateAfterMinute,
  };
  // Late arrivals are counted per calendar month, so the count for a day in the
  // middle of the range needs every day since its month began.
  const monthStart = `${input.from.slice(0, 7)}-01`;
  const rulesFrom = policy.from && policy.from <= input.to && input.userIds.length > 0 ? policy.from : null;

  // The sandwich rule judges a Sunday by the Saturday before and the Monday
  // after, which can fall one day outside the range: read one day wider.
  const sandwichOn = rulesFrom !== null && policy.sandwichFrom !== null && policy.sandwichFrom <= input.to;
  const wideFrom = sandwichOn ? addDays(input.from, -1) : input.from;
  const wideTo = sandwichOn ? addDays(input.to, 1) : input.to;
  // Tracked minutes for those two outside days, which no caller holds.
  const edgeDays = sandwichOn
    ? [
      ...(weekdayForDate(wideFrom) === 'sat' ? [wideFrom] : []),
      ...(weekdayForDate(wideTo) === 'mon' ? [wideTo] : []),
    ]
    : [];

  const fromDate = new Date(`${wideFrom}T00:00:00Z`);
  const toDate = new Date(`${wideTo}T00:00:00Z`);
  const overlap = { startDate: { lte: toDate }, endDate: { gte: fromDate } };
  const lateFrom = rulesFrom && monthStart <= rulesFrom ? rulesFrom : monthStart;
  const dates = !rulesFrom || input.to < lateFrom ? [] : leaveDateRange(lateFrom, input.to, 400);
  const readFrom = wideFrom < lateFrom ? wideFrom : lateFrom;

  // One round of reads: none of them needs another's rows, and the rule rows
  // are only read when the rules are on.
  const [people, punchFor, ruleRows] = await Promise.all([
    input.userIds.length === 0
      ? []
      : prisma.user.findMany({
          where: { id: { in: input.userIds } },
          select: { id: true, attendanceRuleMode: true },
        }),
    loadPunchLookup({ userIds: input.userIds, from: wideFrom < monthStart ? wideFrom : monthStart, to: wideTo }),
    rulesFrom === null
      ? null
      : Promise.all([
          prisma.attendancePunch.groupBy({
            by: ['date'],
            where: { workspaceId: input.workspaceId, date: { gte: fromDate, lte: toDate } },
          }),
          // From the month's start: the late count walks every day since then.
          loadApprovedWfh({ workspaceId: input.workspaceId, userIds: input.userIds, from: readFrom, to: wideTo }),
          prisma.leaveRequest.findMany({
            where: {
              workspaceId: input.workspaceId,
              userId: { in: input.userIds },
              status: { in: ['PENDING', 'REJECTED'] },
              ...overlap,
            },
            select: { userId: true, startDate: true, endDate: true },
          }),
          loadWorkingCalendar({ workspaceId: input.workspaceId, tz: input.tz, userIds: input.userIds, from: readFrom, to: wideTo }),
          prisma.attendanceOverride.findMany({
            where: {
              userId: { in: input.userIds },
              date: { gte: new Date(`${readFrom}T00:00:00Z`), lte: toDate },
            },
            select: { userId: true, date: true, code: true },
          }),
          dates.length === 0
            ? null
            : loadDayFactAssignments({ userIds: input.userIds, from: lateFrom, to: input.to, tz: input.tz }),
          Promise.all(edgeDays.map(async (day) => {
            const timeline = await loadTimeline({ userIds: input.userIds, from: day, to: day, tz: input.tz });
            return [day, timeline] as const;
          })),
        ]),
  ]);
  const modeOf = new Map(people.map((p) => [p.id, p.attendanceRuleMode]));
  const modeFor = (userId: string): AttendanceRuleMode => modeOf.get(userId) ?? 'STANDARD';
  if (!ruleRows || !policy.from) {
    return { policy, enabled: false, judge: () => null, lateOrdinalFor: () => null, modeFor, punchFor };
  }
  const [coveredDates, wfhApproved, unapprovedLeave, calendar, overrides, shiftAssignments, edgeTimelines] = ruleRows;

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
  const leaveApplied = ranges(unapprovedLeave);
  const today = dateKeyInTimeZone(new Date(input.nowMs ?? Date.now()), input.tz);

  // Late arrivals, numbered within each month in date order: the door punch-in
  // against the shift assigned for that date, one grace for everyone (on a
  // first-half leave day, the policy's afternoon time instead).
  const facts = shiftAssignments === null
    ? null
    : dayFactsFrom(shiftAssignments, {
        tz: input.tz,
        calendar: { dayStatusFor: (userId, date) => calendar.dayStatus(userId, date) },
        punchFor,
      });
  const overrideCode = new Map<string, SandwichOverrideCode>(
    overrides.map((o) => [`${o.userId}|${o.date.toISOString().slice(0, 10)}`, o.code]),
  );
  const overridden = new Set(overrideCode.keys());
  const edgeMinutes = new Map(edgeTimelines.map(([day, timeline]) => [day, timeline] as const));

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
        wfhApproved: wfhApproved(userId, date),
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

  /** One day's own verdict on the minimums in force that day, late rule aside. */
  const dayVerdict = (userId: string, date: string, status: DayStatus | null, trackedMinutes: number) => {
    const punch = punchFor(userId, date);
    return judgeDay({ ...policy, ...minimumsOn(date, policy, policy.minimumsHistory) }, {
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
  };

  /**
   * The sandwich rule for a Sunday. Its Saturday and Monday are judged here the
   * way the caller judges any day, on this context's calendar; their minutes
   * come from the caller inside its range, from the edge reads outside it.
   */
  const sandwichVerdict = (
    userId: string,
    date: string,
    status: DayStatus | null,
    minutesOn: ((date: string) => number) | undefined,
  ): AttendanceRuleVerdict | null => {
    const side = (day: string) => {
      const edge = edgeMinutes.get(day);
      const minutes = edge
        ? Math.round(edge.bucket(userId, day).counted / 60_000)
        : day >= input.from && day <= input.to && minutesOn
          ? minutesOn(day)
          : null;
      const sideStatus = calendar.dayStatus(userId, day);
      const override = overrideCode.get(`${userId}|${day}`) ?? null;
      return {
        date: day,
        status: sideStatus,
        override,
        verdict: minutes === null ? null : dayVerdict(userId, day, sideStatus, minutes),
      };
    };
    const saturday = side(addDays(date, -1));
    const monday = side(addDays(date, 1));
    // Without the minutes a side's own rules cannot be judged, so only approved
    // leave or a correction can say it was away.
    return judgeSandwich({
      date,
      today,
      rulesFrom: policy.from,
      sandwichFrom: policy.sandwichFrom,
      mode: modeFor(userId),
      status,
      saturday,
      monday,
    });
  };

  return {
    policy,
    enabled: true,
    lateOrdinalFor,
    modeFor,
    punchFor,
    judge: (userId, date, status, trackedMinutes, minutesOn) => {
      let base = dayVerdict(userId, date, status, trackedMinutes);
      if (!base && sandwichOn && weekdayForDate(date) === 'sun') {
        base = sandwichVerdict(userId, date, status, minutesOn);
      }
      if (!policy.from || date < policy.from || date >= today) return base;
      return withLateRule(base, lateOrdinalFor(userId, date), policy.lateAllowedPerMonth);
    },
  };
}

/** The late lookup the member report reads, or undefined when the rules are off. */
export function lateLookup(rules: AttendanceRuleContext): { from: string; ordinalFor: (userId: string, date: string) => number | null } | undefined {
  return rules.enabled && rules.policy.from ? { from: rules.policy.from, ordinalFor: rules.lateOrdinalFor } : undefined;
}
