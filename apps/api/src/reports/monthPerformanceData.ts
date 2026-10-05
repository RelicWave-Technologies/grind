import { prisma } from '@grind/db';
import { dateKeyInTimeZone, dateKeysBetween, isValidTimeZone, type DayStatus } from '@grind/types';
import { loadPunchLookup } from '../attendance/punches';
import { loadAttendanceRuleContext, type AttendanceRuleContext } from '../attendance/ruleContext';
import { reconcileRuleLedger, verdictKey, type RuleVerdicts } from '../attendance/ruleLedger';
import { timesheetCalendarInputs } from '../leave';
import { loadTimeline } from '../time';
import { loadBalances } from '../leave/repository';
import {
  buildMonthPerformance,
  type DayOverride,
  type MonthPerformanceReport,
  type MonthPerformanceUser,
} from './monthPerformance';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;

export interface ResolvedReportMonth {
  /** YYYY-MM. */
  month: string;
  /** First and last date of the month, YYYY-MM-DD. */
  from: string;
  to: string;
  tz: string;
}

/**
 * Read the requested month off a query string, defaulting to the month it is
 * now in the workspace's own timezone.
 */
export function resolveReportMonth(
  query: Record<string, unknown>,
  workspaceTz: string,
): ResolvedReportMonth | { error: string } {
  if (!isValidTimeZone(workspaceTz)) return { error: 'invalid_tz' };

  let month: string;
  if (typeof query.month === 'string' && MONTH_RE.test(query.month)) {
    month = query.month;
  } else if (query.month == null) {
    month = dateKeyInTimeZone(new Date(), workspaceTz).slice(0, 7);
  } else {
    return { error: 'invalid_month' };
  }

  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return { error: 'invalid_month' };
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    month,
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, '0')}`,
    tz: workspaceTz,
  };
}

interface MonthInputs {
  reportUsers: MonthPerformanceUser[];
  userIds: string[];
  companyName: string;
  calendarInput: { workspaceId: string; tz: string; userIds: string[]; from: string; to: string };
  punchFor: Awaited<ReturnType<typeof loadPunchLookup>>;
  overrides: Array<{ userId: string; date: Date; code: DayOverride['code']; computedCode: DayOverride['computedCode'] }>;
  /** Counted minutes (work, meetings, approved manual; invalidated excluded). */
  trackedMinutesFor: (userId: string, date: string) => number;
  rules: AttendanceRuleContext;
  nowMs: number;
}

/** Everything a month is judged on, read once. Nothing here writes. */
async function loadMonthInputs(input: {
  workspaceId: string;
  userIds: string[];
  range: ResolvedReportMonth;
  nowMs?: number;
}): Promise<MonthInputs> {
  const { range } = input;
  const nowMs = input.nowMs ?? Date.now();

  const [workspace, users] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { name: true } }),
    input.userIds.length === 0
      ? []
      : prisma.user.findMany({
          where: { id: { in: input.userIds }, workspaceId: input.workspaceId, deactivatedAt: null },
          select: { id: true, name: true, email: true, team: { select: { name: true } } },
          orderBy: [{ name: 'asc' }, { email: 'asc' }],
        }),
  ]);

  const reportUsers: MonthPerformanceUser[] = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    teamName: u.team?.name ?? null,
  }));
  const userIds = reportUsers.map((u) => u.id);

  const calendarInput = {
    workspaceId: input.workspaceId,
    tz: range.tz,
    userIds,
    from: range.from,
    to: range.to,
  };
  // Time comes from the shared timeline: the same owner-per-minute, proven
  // open ends and invalidations as Edit Time and the reports, so the hours
  // here cannot disagree with the hours anywhere else.
  const [punchFor, timeline, overrides] = await Promise.all([
    loadPunchLookup({ userIds, from: range.from, to: range.to }),
    loadTimeline({ userIds, from: range.from, to: range.to, tz: range.tz, now: new Date(nowMs) }),
    userIds.length === 0 ? [] : prisma.attendanceOverride.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: new Date(`${range.from}T00:00:00Z`), lte: new Date(`${range.to}T00:00:00Z`) },
      },
      select: { userId: true, date: true, code: true, computedCode: true },
    }),
  ]);
  const rules = await loadAttendanceRuleContext({ ...calendarInput, punchFor, nowMs });

  return {
    reportUsers,
    userIds,
    companyName: workspace?.name ?? '',
    calendarInput,
    punchFor,
    overrides,
    trackedMinutesFor: (userId, date) => Math.round(timeline.bucket(userId, date).counted / 60_000),
    rules,
    nowMs,
  };
}

/** The rule verdict for every judged, uncorrected person-day. */
function monthVerdicts(
  m: MonthInputs,
  days: readonly string[],
  dayStatusFor: (userId: string, date: string) => DayStatus | null,
): RuleVerdicts {
  const verdicts: RuleVerdicts = new Map();
  if (!m.rules.enabled) return verdicts;
  const overridden = new Set(m.overrides.map((o) => `${o.userId}|${o.date.toISOString().slice(0, 10)}`));
  for (const userId of m.userIds) {
    for (const date of days) {
      // A corrected day is the corrector's call, and costs what they said.
      if (overridden.has(`${userId}|${date}`)) continue;
      const verdict = m.rules.judge(userId, date, dayStatusFor(userId, date), m.trackedMinutesFor(userId, date));
      if (verdict) verdicts.set(verdictKey(userId, date), verdict);
    }
  }
  return verdicts;
}

/**
 * Write the attendance rules' charges for a month to the leave ledger.
 *
 * The only writer of rule lines. Run by the scheduler (current and previous
 * month) and after writes that change a verdict — an attendance correction,
 * for instance. Reading the month report never writes: a GET must not move a
 * balance.
 */
export async function reconcileMonthRules(input: {
  workspaceId: string;
  userIds: string[];
  range: ResolvedReportMonth;
  nowMs?: number;
}): Promise<{ written: number; removed: number }> {
  const m = await loadMonthInputs(input);
  const calendar = await timesheetCalendarInputs(m.calendarInput);
  const days = dateKeysBetween(input.range.from, input.range.to);
  return reconcileRuleLedger({
    workspaceId: input.workspaceId,
    userIds: m.userIds,
    from: input.range.from,
    to: input.range.to,
    verdicts: monthVerdicts(m, days, calendar.dayStatusFor),
  });
}

/**
 * Load the month performance grid.
 *
 * Four reads: the tracked time that decides whether a day was worked, the
 * Working Calendar that the Lark leave integration feeds, the punch records
 * behind the Office In / Office Out rows, and any corrections a manager or
 * admin has made to individual days.
 *
 * The timesheet matrix is built the same way every other surface builds it, so
 * the hours here cannot disagree with the hours on /attendance. Nothing here
 * applies a monthly guarantee or carries time between days: either would
 * quietly rewrite days, and an attendance record has to stay literal.
 *
 * Scoped by `userIds` rather than by workspace, so a manager pulling this
 * export gets their team and nobody else.
 *
 * Read-only. The rules' ledger lines are written by `reconcileMonthRules`
 * (scheduled, and after the writes that change a verdict), never here.
 */
export async function loadMonthPerformanceReport(input: {
  workspaceId: string;
  userIds: string[];
  range: ResolvedReportMonth;
  nowMs?: number;
}): Promise<MonthPerformanceReport> {
  const { range } = input;
  const m = await loadMonthInputs(input);
  const { reportUsers, userIds, punchFor, overrides, trackedMinutesFor, rules, nowMs } = m;
  // Read-only: the ledger lines the rules wrote are whatever the last
  // reconcile left (see `reconcileMonthRules`), and the calendar prices the
  // month from them.
  const calendar = await timesheetCalendarInputs(m.calendarInput);
  const overrideIndex = new Map<string, DayOverride>();
  for (const o of overrides) {
    // A DATE column reads back as an epoch-anchored Date; no timezone applies.
    const date = o.date.toISOString().slice(0, 10);
    overrideIndex.set(`${o.userId}|${date}`, {
      code: o.code,
      computedCode: o.computedCode,
      // The correction says the day was leave; this says how much of it the
      // balance paid for. Same walk that answers it for leave filed in Lark.
      fundedDays: calendar.fundedDaysFor(o.userId, date),
    });
  }
  const overrideFor = (userId: string, date: string): DayOverride | null =>
    overrideIndex.get(`${userId}|${date}`) ?? null;

  // As of the last day of the month, not today: a report of August has to keep
  // saying the same thing in October, and a balance read at render time would
  // drift away from the days printed beside it.
  const balances = userIds.length === 0 ? {} : await loadBalances(userIds, range.to);

  return buildMonthPerformance({
    month: range.month,
    tz: range.tz,
    companyName: m.companyName,
    users: reportUsers,
    dayStatusFor: calendar.dayStatusFor,
    trackedMinutesFor,
    punchFor,
    overrideFor,
    balanceFor: (userId) => balances[userId]?.balanceDays,
    leaveAccountFor: calendar.leaveAccountFor,
    today: dateKeyInTimeZone(new Date(nowMs), range.tz),
    ruleFor: rules.enabled ? rules.judge : undefined,
    fundedDaysFor: calendar.fundedDaysFor,
    lateOrdinalFor: rules.enabled ? rules.lateOrdinalFor : undefined,
    rulesFrom: rules.enabled ? rules.policy.from : null,
    ruleMinutes: rules.enabled
      ? {
          fullDay: rules.policy.fullDayMinMinutes,
          halfDay: rules.policy.halfDayMinMinutes,
          lateAllowed: rules.policy.lateAllowedPerMonth,
          lateGrace: rules.policy.lateGraceMinutes,
        }
      : null,
    generatedAtMs: nowMs,
  });
}
