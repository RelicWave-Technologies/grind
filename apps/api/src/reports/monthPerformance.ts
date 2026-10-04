import {
  displayDayCode,
  attendanceOverrideShape,
  type DisplayDayCode,
  type AttendanceOverrideCode,
  type AttendanceRuleVerdict,
  type DayStatus,
} from '@grind/types';
import type { PunchLookup } from '../attendance/punches';
import type { LeaveAccount } from '../leave/leaveFunding';
import { ruleCode } from '../attendance/rules';
import { weekdayForDate } from '../leave';

/**
 * Month performance — one month of attendance per person, laid out the way the
 * attendance machine lays it out: days across the top, and one block per person
 * carrying punch in, punch out, worked hours and a status code.
 *
 * ## Three sources
 *
 * **Timo's tracked time** decides whether a day counts as worked — it is the
 * measure of work actually done, rather than of time spent between two badge
 * readings. **The Working Calendar**, fed by the Lark leave integration, says
 * whether the person was meant to be there at all: holiday, weekly off,
 * approved leave. **The punch record** (`AttendancePunch`) supplies the office
 * in and office out times, which are shown as recorded and never inferred.
 *
 * Punch and tracked time sit side by side on purpose. Where they disagree —
 * badged in at 09:55, tracked two hours — the row shows both and the reader can
 * see the gap rather than having it silently resolved.
 *
 * The payroll classifier is deliberately NOT used. Its monthly guarantee
 * upgrades every eligible day once the month total clears a floor, and its
 * carry allocator moves surplus time between days. Both are right for deciding
 * pay and both would make an attendance record untrue. Every day here is judged
 * on its own tracked time and nothing else.
 *
 * ## How a day is judged
 *
 * A human's correction first, then leave, then hours. There is no threshold.
 *
 * A manager or admin can say what a day WAS, and that wins outright — the two
 * computed sources are both capable of being wrong about a real day, and a
 * person who was there is the better authority. The override never touches the
 * hours: those keep reporting what Timo tracked, so "the manager says present"
 * and "the machine recorded 5:37" stay two separate, visible facts.
 *
 *     HL / WO / PL / LWP        whatever the calendar recorded, even when the
 *     PL_HD / LWP_HD            person worked that day anyway
 *     P                         any tracked time at all
 *     A                         a working day with none
 *
 * Until the attendance rules are switched on there is no minimum: the status
 * answers "did they work", the hours answer "how much". From the date the
 * leave policy names, the company's rules apply instead (see
 * `attendance/rules.ts`) — a day short of the minimums, worked from home
 * without approval or missed without an approved application is leave, paid or
 * unpaid by the balance like any other, and the day's `rule` says which rule
 * made it so. The hours still print exactly what was tracked.
 */

/**
 * What a single day reads as.
 *
 * The half-day and unpaid splits are ones the machine does not make — it has no
 * half day, and shows every absence as one code — but the Lark leave data knows
 * which leave was a half day, and the ledger knows which days a balance paid
 * for. Discarding either would be a loss.
 *
 * A half day carries the same paid/unpaid answer a full day carries, which is
 * why there is no bare `HD`: a half day taken with nothing left in the balance
 * used to read exactly like one taken with a balance behind it, so the only
 * days the report could not account for were the ones it rendered as identical.
 *
 * `PL` rather than `LV` for paid leave: PL is what everybody here already reads
 * on a leave form, and a report is not the place to teach a new abbreviation.
 */
export type MonthPerformanceCode =
  /** Present — any tracked time on the day. */
  | 'P'
  /** Half day of paid leave — a balance covered it. Never inferred from hours. */
  | 'PL_HD'
  /** Half day of leave the balance did not cover. */
  | 'LWP_HD'
  /** A full day the balance reached halfway: half of it paid, half of it not. */
  | 'PL_HD/LWP_HD'
  /** Absent — a working day with no tracked time at all. */
  | 'A'
  /** Weekly off — the assigned shift has this weekday off. */
  | 'WO'
  /** Company holiday. */
  | 'HL'
  /** Approved paid leave, full day. */
  | 'PL'
  /** Approved unpaid leave, full day. */
  | 'LWP'
  /** No shift assignment covers this date, and nothing tracked either. */
  | '--';

export interface RuleSettings {
  fullDay: number;
  halfDay: number;
  lateAllowed: number;
  lateGrace: number;
}

export interface MonthPerformanceUser {
  id: string;
  name: string;
  email: string;
  /** Team name — the report's "Dept. Name". */
  teamName: string | null;
}

export interface MonthPerformanceDay {
  /** YYYY-MM-DD in the workspace timezone. */
  date: string;
  /** 1-31, the column this day occupies. */
  dayOfMonth: number;
  /** 'Sat', 'Sun', … — the second header row of the grid. */
  weekday: string;
  /** Minutes since local midnight from the punch record, null when unrecorded. */
  punchInMinute: number | null;
  punchOutMinute: number | null;
  /** Tracked minutes for the day — work, meetings and approved manual time. */
  workMinutes: number;
  code: MonthPerformanceCode;
  /** 'Diwali', 'Paid leave' — whatever the calendar called it. */
  label: string | null;
  /**
   * Set when a human corrected this day. `stale` means the computed answer has
   * changed since the correction was made, so the two now disagree about a day
   * they once agreed on.
   */
  override: { code: AttendanceOverrideCode; stale: boolean } | null;
  /** What the day reads as with nobody's correction. */
  computedCode: MonthPerformanceCode;
  /** The attendance rule that charged this day, when one did. */
  rule: AttendanceRuleVerdict | null;
  /** The month's Nth late arrival, when this day was one. */
  late: number | null;
}

export interface MonthPerformanceTotals {
  present: number;
  /** Half days a balance paid for. */
  paidHalfDay: number;
  /** Half days it did not. */
  unpaidHalfDay: number;
  /** Full days the balance reached halfway — half paid, half not. */
  splitLeave: number;
  weeklyOff: number;
  holiday: number;
  /** Paid leave days. */
  paidLeave: number;
  /** Unpaid leave days. */
  unpaidLeave: number;
  absent: number;
  noShift: number;
  /** Sum of the WORK row. */
  workMinutes: number;
  /** Days each attendance rule charged, by rule. */
  shortDay: number;
  underMin: number;
  halfDayShort: number;
  wfhUnapproved: number;
  /** Absent with no approved application — pending and rejected included. */
  leaveWithoutApproval: number;
  /** Leave days the rules charged in total, on the 0.5 grid. */
  ruleDays: number;
  /** Late arrivals this month, charged or not. */
  lateDays: number;
}

export interface MonthPerformanceRow {
  user: MonthPerformanceUser;
  days: MonthPerformanceDay[];
  totals: MonthPerformanceTotals;
  /**
   * Paid-leave days left at the end of the month, or null when nobody asked.
   *
   * Sits beside the counts rather than inside them: every other number here is
   * days of this month, and this one is what the month left behind.
   */
  balanceDays: number | null;
  /**
   * The month's leave account — opening, earned, paid, closing — from the same
   * walk that decides which days were paid. null when nobody asked.
   */
  leaveAccount: LeaveAccount | null;
}

export interface MonthPerformanceReport {
  /** YYYY-MM. */
  month: string;
  /** 'August-2026' — how the grid header prints it. */
  monthLabel: string;
  tz: string;
  companyName: string;
  generatedAtMs: number;
  /** Every day of the month, in order. The column axis for every row. */
  dates: string[];
  rows: MonthPerformanceRow[];
  /**
   * First date the attendance rules judge, when they are on for any day of
   * this month. null keeps the report exactly as it was before the rules.
   */
  rulesFrom: string | null;
  /**
   * The rules' settings, for the sheet's Why row ("<7h") and its legend:
   * minimum minutes, free late arrivals a month, and the late grace.
   */
  ruleMinutes: RuleSettings | null;
}

export interface MonthPerformanceInput {
  month: string;
  tz: string;
  companyName: string;
  users: MonthPerformanceUser[];
  /** The Working Calendar's answer for a person-day. null = it has none. */
  dayStatusFor: (userId: string, date: string) => DayStatus | null;
  /** Minutes Timo tracked for this person on this date. */
  trackedMinutesFor: (userId: string, date: string) => number;
  punchFor: PunchLookup;
  /** A manager's or admin's correction for this person-day, if one exists. */
  overrideFor?: (userId: string, date: string) => DayOverride | null;
  /**
   * Paid-leave days this person had left at the end of the month, or undefined
   * when the caller did not ask the ledger.
   *
   * At the end, not today: a month's report has to keep saying the same thing
   * next week, and a balance read at render time would drift away from the days
   * printed beside it.
   */
  balanceFor?: (userId: string) => number | undefined;
  /** The month's leave account per person. */
  leaveAccountFor?: (userId: string) => LeaveAccount | undefined;
  /** The attendance rules' verdict for a person-day, null when nothing is charged. */
  ruleFor?: (userId: string, date: string, status: DayStatus | null, trackedMinutes: number) => AttendanceRuleVerdict | null;
  /** How much of a day's cost a balance covered, undefined when it covered all. */
  fundedDaysFor?: (userId: string, date: string) => number | undefined;
  /** The month's Nth late arrival on this day, null when on time. */
  lateOrdinalFor?: (userId: string, date: string) => number | null;
  /** See `MonthPerformanceReport.rulesFrom`. */
  rulesFrom?: string | null;
  /** See `MonthPerformanceReport.ruleMinutes`. */
  ruleMinutes?: RuleSettings | null;
  /**
   * Today, YYYY-MM-DD in the workspace timezone. A working day from today on
   * with nothing tracked has not happened yet, so it reads `--`, not absent.
   */
  today?: string;
  generatedAtMs: number;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const WEEKDAY_LABEL: Record<string, string> = {
  sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat',
};

/** 'August-2026' from '2026-08'. */
export function monthLabelOf(month: string): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  const name = MONTH_NAMES[(m ?? 1) - 1];
  return name && y ? `${name}-${y}` : month;
}

/**
 * Every date in a YYYY-MM month, in order. Derived from the month rather than
 * from whichever days happen to have data, so an empty report still knows its
 * own column axis.
 */
export function monthDates(month: string): string[] {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return [];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= last; d++) out.push(`${month}-${String(d).padStart(2, '0')}`);
  return out;
}

/**
 * Minutes since midnight as 'HH:MM', or the report's own dash for "not
 * recorded". The dash is deliberate: a missing punch is a fact, and printing
 * 00:00 for it would be a different, false fact.
 */
export function fmtClock(minute: number | null): string {
  if (minute === null) return '--:--';
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * A duration as 'HH:MM', counting hours past 24 rather than wrapping — a month
 * total of 146:20 is a number of hours, not a time of day.
 */
export function fmtMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A human's correction to one day, if one was made. */
export interface DayOverride {
  code: AttendanceOverrideCode;
  /** What the report computed when the override was written. */
  computedCode: string | null;
  /**
   * Days of this date's leave a balance covered, when it did not cover the
   * whole cost. Undefined means covered — or that nobody asked, which reads the
   * same and is the answer a caller without a ledger should get.
   */
  fundedDays?: number;
}

/**
 * The code for one day.
 *
 * The calendar is asked first and wins outright: a company holiday is a holiday
 * whether or not somebody badged in, and approved leave is leave. Somebody who
 * did come in on one of those days is not hidden — the IN, OUT and WORK rows
 * still show it — but the status code has to keep counting the day as what it
 * was, or the holiday and leave tallies stop adding up.
 *
 * Only a day the calendar calls WORKING, or has no opinion on, falls through to
 * the tracked time.
 */
export function codeForDay(
  status: DayStatus | null,
  trackedMinutes: number,
  override?: DayOverride | null,
): MonthPerformanceCode {
  if (override) return overrideCode(override);
  return computedCodeForDay(status, trackedMinutes);
}

/**
 * A hand-set correction as the report renders it.
 *
 * The correction says what shape the day was — present, absent, half a day
 * away, a whole day away. Whether the leave was paid is not its to say: that
 * is the balance's answer, and it arrives as `fundedDays` from the same walk
 * that decides it for leave filed in Lark. So a manager cannot hand out paid
 * leave the ledger will not back, and does not have to guess at a balance to
 * record what they saw.
 *
 * Retired spellings are read as the shape they described rather than rewritten
 * in the database: an untouched row keeps saying what its author chose, and
 * only the rendering moves on.
 */
export function overrideCode(override: DayOverride): MonthPerformanceCode {
  const funded = override.fundedDays;
  switch (attendanceOverrideShape(override.code)) {
    case 'P': return 'P';
    case 'A': return 'A';
    // A half day costs half a day, so a balance either covered it or covered
    // none of it. There is no third answer to draw.
    case 'HALF_LEAVE': return funded == null ? 'PL_HD' : 'LWP_HD';
    case 'FULL_LEAVE':
      if (funded == null) return 'PL';
      return funded > 0 ? 'PL_HD/LWP_HD' : 'LWP';
  }
}

/**
 * What the day would read without anybody's correction.
 *
 * Kept separate so an override can be compared against it: the code recorded
 * when the override was written is checked against this on every render, and a
 * day whose ground has moved since is flagged rather than silently disagreeing
 * with the calendar.
 */
export function computedCodeForDay(
  status: DayStatus | null,
  trackedMinutes: number,
): MonthPerformanceCode {
  switch (status?.kind) {
    case 'HOLIDAY': return 'HL';
    case 'WEEKLY_OFF': return 'WO';
    case 'PAID_LEAVE': {
      if (status.expectedFraction > 0) return 'PL_HD';
      // A full day the balance only reached halfway. `fundedDays` is absent
      // when nobody asked the ledger, and the day is simply paid then.
      const funded = status.fundedDays;
      return funded != null && funded < 1 ? 'PL_HD/LWP_HD' : 'PL';
    }
    case 'UNPAID_LEAVE': return status.expectedFraction > 0 ? 'LWP_HD' : 'LWP';
    default: break;
  }
  if (trackedMinutes > 0) return 'P';
  // Nothing tracked and no shift assignment: we cannot call somebody absent
  // from a day we never said they had to be there for.
  if (trackedMinutes === 0 && (!status || status.kind === 'NO_SHIFT')) return '--';
  return 'A';
}

/**
 * The computed code once the attendance rules have had their say. A day no rule
 * charged reads exactly as it did before the rules existed.
 */
export function computedCodeWithRule(
  status: DayStatus | null,
  trackedMinutes: number,
  rule: AttendanceRuleVerdict | null,
  fundedDays: number | undefined,
): MonthPerformanceCode {
  if (rule && status) return ruleCode(status, rule, fundedDays);
  return computedCodeForDay(status, trackedMinutes);
}

function emptyTotals(): MonthPerformanceTotals {
  return {
    present: 0, paidHalfDay: 0, unpaidHalfDay: 0, splitLeave: 0,
    weeklyOff: 0, holiday: 0, paidLeave: 0,
    unpaidLeave: 0, absent: 0, noShift: 0, workMinutes: 0,
    shortDay: 0, underMin: 0, halfDayShort: 0, wfhUnapproved: 0,
    leaveWithoutApproval: 0, ruleDays: 0, lateDays: 0,
  };
}

function countRuleInto(totals: MonthPerformanceTotals, rule: AttendanceRuleVerdict): void {
  switch (rule.tag) {
    case 'SHORT_DAY': totals.shortDay += 1; break;
    case 'UNDER_MIN': totals.underMin += 1; break;
    case 'HALF_DAY_SHORT': totals.halfDayShort += 1; break;
    case 'WFH_UNAPPROVED': totals.wfhUnapproved += 1; break;
    case 'NO_APPLICATION':
    case 'LEAVE_NOT_APPROVED': totals.leaveWithoutApproval += 1; break;
  }
  totals.ruleDays += rule.penaltyDays;
}

function countInto(totals: MonthPerformanceTotals, code: MonthPerformanceCode): void {
  switch (code) {
    case 'P': totals.present += 1; break;
    case 'PL_HD': totals.paidHalfDay += 1; break;
    case 'LWP_HD': totals.unpaidHalfDay += 1; break;
    case 'PL_HD/LWP_HD': totals.splitLeave += 1; break;
    case 'WO': totals.weeklyOff += 1; break;
    case 'HL': totals.holiday += 1; break;
    case 'PL': totals.paidLeave += 1; break;
    case 'LWP': totals.unpaidLeave += 1; break;
    case 'A': totals.absent += 1; break;
    case '--': totals.noShift += 1; break;
  }
}

/**
 * Assemble the grid. Pure — the calendar and the punches are handed in as
 * lookups, which is what makes the whole layout testable without a database.
 */
export function buildMonthPerformance(input: MonthPerformanceInput): MonthPerformanceReport {
  const dates = monthDates(input.month);

  const rows: MonthPerformanceRow[] = input.users.map((user) => {
    const totals = emptyTotals();
    const days: MonthPerformanceDay[] = dates.map((date) => {
      const punch = input.punchFor(user.id, date);
      const status = input.dayStatusFor(user.id, date);
      const inMinute = punch?.inMinute ?? null;
      const outMinute = punch?.outMinute ?? null;
      const workMinutes = Math.max(0, Math.round(input.trackedMinutesFor(user.id, date)));
      const override = input.overrideFor?.(user.id, date) ?? null;
      // Judged even under a correction, so the correction can be flagged when
      // the computed answer moves — but a corrected day is charged nothing by a
      // rule, because the person who corrected it is the better authority.
      const verdict = input.ruleFor?.(user.id, date, status, workMinutes) ?? null;
      let computed = computedCodeWithRule(status, workMinutes, verdict, input.fundedDaysFor?.(user.id, date));
      if (computed === 'A' && input.today && date >= input.today) computed = '--';
      const code = override ? overrideCode(override) : computed;
      const rule = override ? null : verdict;

      // A correction answers for the whole day, lateness included.
      const late = override ? null : (input.lateOrdinalFor?.(user.id, date) ?? null);

      countInto(totals, code);
      if (rule) countRuleInto(totals, rule);
      if (late !== null) totals.lateDays += 1;
      totals.workMinutes += workMinutes;

      return {
        date,
        dayOfMonth: Number.parseInt(date.slice(8, 10), 10),
        weekday: WEEKDAY_LABEL[weekdayForDate(date)] ?? '',
        punchInMinute: inMinute,
        punchOutMinute: outMinute,
        workMinutes,
        code,
        label: status?.label ?? null,
        override: override
          ? { code: override.code, stale: override.computedCode !== null && override.computedCode !== computed }
          : null,
        computedCode: computed,
        rule,
        late,
      };
    });
    return {
      user,
      days,
      totals,
      balanceDays: input.balanceFor?.(user.id) ?? null,
      // Somebody with nothing earned and nothing taken still has an account:
      // zeros, not a blank.
      leaveAccount: input.leaveAccountFor
        ? (input.leaveAccountFor(user.id) ?? { opening: 0, earned: 0, paid: 0, closing: 0, lines: [] })
        : null,
    };
  });

  return {
    month: input.month,
    monthLabel: monthLabelOf(input.month),
    tz: input.tz,
    companyName: input.companyName,
    generatedAtMs: input.generatedAtMs,
    dates,
    rows,
    rulesFrom: input.rulesFrom ?? null,
    ruleMinutes: input.ruleMinutes ?? null,
  };
}

// ---------------------------------------------------------------------------
// The sheet's vocabulary
// ---------------------------------------------------------------------------

/** What a day reads as on the exported sheet — see `displayDayCode`. */
export type SheetCode = DisplayDayCode;

export function sheetCode(day: Pick<MonthPerformanceDay, 'code' | 'rule'>): SheetCode {
  return displayDayCode(day.code, day.rule?.tag);
}

/** "7h", "3.5h" — a minimum as people say it. */
function hoursWord(minutes: number): string {
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : Number(h.toFixed(1))}h`;
}

/**
 * Why a rule made the day leave, in two or three plain words. Empty when no
 * rule did. The thresholds come from the policy, so the words stay true when
 * the minimums change.
 */
export function sheetWhy(
  report: Pick<MonthPerformanceReport, 'ruleMinutes'>,
  day: Pick<MonthPerformanceDay, 'rule'> & { late?: number | null },
): string {
  // A late arrival is worth showing even when it costs nothing yet: "late 3"
  // tells the reader how close the month is to the 5th.
  if (!day.rule || day.rule.tag === 'LATE') return day.late ? `late ${day.late}` : '';
  const m = report.ruleMinutes ?? { fullDay: 420, halfDay: 210, lateAllowed: 4, lateGrace: 30 };
  switch (day.rule.tag) {
    case 'SHORT_DAY': return `<${hoursWord(m.fullDay)}`;
    case 'UNDER_MIN':
    case 'HALF_DAY_SHORT': return `<${hoursWord(m.halfDay)}`;
    case 'WFH_UNAPPROVED': return 'WFH';
    case 'NO_APPLICATION': return 'no leave';
    case 'LEAVE_NOT_APPROVED': return 'unapproved';
    default: return '';
  }
}

/**
 * Days of the month that went unpaid — the one number payroll needs. A full
 * day the balance did not cover is 1, an unpaid half is 0.5, and a full day the
 * balance reached halfway is 0.5.
 */
export function salaryCutDays(totals: MonthPerformanceTotals): number {
  return totals.unpaidLeave + 0.5 * (totals.unpaidHalfDay + totals.splitLeave);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Quote a CSV cell if it contains a comma, quote, or newline. RFC 4180-ish. */
function csv(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The six rows that ARE the grid: the day axis, then office in, office out,
 * total working hours and status.
 *
 * The labels are spelled out rather than abbreviated. `IN` / `OUT` / `WORK`
 * were shorter and meant nothing to anybody reading the sheet for the first
 * time — and this sheet is read by people who did not build it.
 *
 * Shared by the CSV and the workbook, because this is where the two exports
 * disagreeing would actually matter. Each export writes its own caption above
 * these rows: a spreadsheet can merge cells to caption a block and a CSV
 * cannot, and forcing one layout to serve both makes both worse.
 *
 * Every row is `1 + dates.length` cells wide, label column first.
 */
export function monthPerformanceGridRows(
  report: MonthPerformanceReport,
  row: MonthPerformanceRow,
): string[][] {
  const byDate = new Map(row.days.map((d) => [d.date, d]));
  const cells = (pick: (d: MonthPerformanceDay | undefined) => string): string[] =>
    report.dates.map((date) => pick(byDate.get(date)));

  return [
    ['', ...report.dates.map((d) => String(Number.parseInt(d.slice(8, 10), 10)))],
    ['', ...cells((d) => d?.weekday ?? '')],
    ['Office In', ...cells((d) => fmtClock(d?.punchInMinute ?? null))],
    ['Office Out', ...cells((d) => fmtClock(d?.punchOutMinute ?? null))],
    ['Total Working Hours', ...cells((d) => fmtMinutes(d?.workMinutes ?? 0))],
    ['Status', ...cells((d) => (d ? sheetCode(d) : '--'))],
    // Why a rule made the day leave. Only once the rules are on, so a month
    // before them keeps the layout it always had.
    ...(report.rulesFrom ? [['Why', ...cells((d) => (d ? sheetWhy(report, d) : ''))]] : []),
  ];
}

/**
 * The summary counts as label/value pairs, in the order the report prints them.
 * One list, so the CSV row and the workbook caption cannot disagree about which
 * counts exist or what they are called.
 *
 * Six numbers, counted in the sheet's own vocabulary so they always match the
 * codes printed above them: the four kinds of working day, the salary cut, and
 * the balance. Holidays and weekly offs are left to the grid — nobody needs
 * them added up to decide anything.
 */
export function monthPerformanceSummaryPairs(row: MonthPerformanceRow): Array<[string, string]> {
  const count = (code: SheetCode) => row.days.filter((d) => sheetCode(d) === code).length;
  return [
    ['Present', String(count('P'))],
    ['Half Day', String(count('HD'))],
    ['Leave', String(count('L'))],
    ['LWA', String(count('LWA'))],
    ['Late', String(row.totals.lateDays)],
    // The paid/unpaid split every cell above leaves out, as the one figure
    // that decides pay.
    ['Salary Cut', `${fmtDays(salaryCutDays(row.totals))} ${salaryCutDays(row.totals) === 1 ? 'day' : 'days'}`],
  ];
}

/**
 * The month's leave account as one line: what the balance opened with, what
 * the month added, what it paid for, and what is left. The four add up —
 * Opening + Earned - Paid = Closing — and leave the balance could not pay for
 * is the Salary Cut beside them, never a negative balance.
 *
 * Falls back to the plain ledger balance for a caller that built the report
 * without the walk.
 */
export function monthPerformanceLeavePairs(row: MonthPerformanceRow): Array<[string, string]> {
  const a = row.leaveAccount;
  if (a) {
    return [
      ['Opening Balance', fmtDays(a.opening)],
      ['Earned', fmtDays(a.earned)],
      ['Paid Leave', fmtDays(a.paid)],
      ['Closing Balance', fmtDays(a.closing)],
    ];
  }
  return row.balanceDays === null ? [] : [['Leave Balance', fmtDays(row.balanceDays)]];
}

/** "2", "1.5", "-0.5" — halves kept, whole numbers left whole. */
function fmtDays(days: number): string {
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

/** One person's eight CSV rows — two caption rows, then the grid. */
export function monthPerformanceBlock(
  report: MonthPerformanceReport,
  row: MonthPerformanceRow,
): string[][] {
  return [
    ['Dept. Name', row.user.teamName ?? '', '', 'CompName', report.companyName, '', 'Report Month', report.monthLabel],
    [
      'Email', row.user.email, '', 'Name', row.user.name, '',
      ...monthPerformanceSummaryPairs(row).flat(),
      ...monthPerformanceLeavePairs(row).flat(),
    ],
    ...monthPerformanceGridRows(report, row),
  ];
}

/**
 * The whole report as CSV — one block per person, stacked, with a blank line
 * between people so a reader can tell the blocks apart.
 */
export function formatMonthPerformanceCsv(report: MonthPerformanceReport): string {
  const lines: string[] = [];
  for (const row of report.rows) {
    for (const cells of monthPerformanceBlock(report, row)) {
      lines.push(cells.map(csv).join(','));
    }
    lines.push('');
  }
  return lines.join('\n');
}
