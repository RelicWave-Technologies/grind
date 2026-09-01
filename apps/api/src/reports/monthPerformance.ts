import type { DayStatus } from '@grind/types';
import type { PunchLookup } from '../attendance/punches';
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
 * Leave first, hours second. There is no third rule and no threshold.
 *
 *     HL / WO / PL / LWP / HD   whatever the calendar recorded, even when the
 *                               person worked that day anyway
 *     P                         any tracked time at all
 *     A                         a working day with none
 *
 * Deliberately no minimum. A floor at four or eight hours only decides which
 * side of an arbitrary line a real working day falls on, and every hour of it
 * is already printed on the row above — the reader can see six hours and judge
 * six hours. The status answers "did they work", the hours answer "how much".
 */

/**
 * What a single day reads as.
 *
 * `HD` and `LWP` are splits the machine does not make — it has no half day, and
 * shows every absence as one code — but the Lark leave data knows which leave
 * was a half day and which was unpaid, and discarding that would be a loss.
 *
 * `PL` rather than `LV` for paid leave: PL is what everybody here already reads
 * on a leave form, and a report is not the place to teach a new abbreviation.
 */
export type MonthPerformanceCode =
  /** Present — any tracked time on the day. */
  | 'P'
  /** Half day — approved leave covering half the day. Never inferred from hours. */
  | 'HD'
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
}

export interface MonthPerformanceTotals {
  present: number;
  halfDay: number;
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
}

export interface MonthPerformanceRow {
  user: MonthPerformanceUser;
  days: MonthPerformanceDay[];
  totals: MonthPerformanceTotals;
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
): MonthPerformanceCode {
  switch (status?.kind) {
    case 'HOLIDAY': return 'HL';
    case 'WEEKLY_OFF': return 'WO';
    case 'PAID_LEAVE': return status.expectedFraction > 0 ? 'HD' : 'PL';
    case 'UNPAID_LEAVE': return status.expectedFraction > 0 ? 'HD' : 'LWP';
    default: break;
  }
  if (trackedMinutes > 0) return 'P';
  // Nothing tracked and no shift assignment: we cannot call somebody absent
  // from a day we never said they had to be there for.
  if (trackedMinutes === 0 && (!status || status.kind === 'NO_SHIFT')) return '--';
  return 'A';
}

function emptyTotals(): MonthPerformanceTotals {
  return {
    present: 0, halfDay: 0, weeklyOff: 0, holiday: 0, paidLeave: 0,
    unpaidLeave: 0, absent: 0, noShift: 0, workMinutes: 0,
  };
}

function countInto(totals: MonthPerformanceTotals, code: MonthPerformanceCode): void {
  switch (code) {
    case 'P': totals.present += 1; break;
    case 'HD': totals.halfDay += 1; break;
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
      const code = codeForDay(status, workMinutes);

      countInto(totals, code);
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
      };
    });
    return { user, days, totals };
  });

  return {
    month: input.month,
    monthLabel: monthLabelOf(input.month),
    tz: input.tz,
    companyName: input.companyName,
    generatedAtMs: input.generatedAtMs,
    dates,
    rows,
  };
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
    ['Status', ...cells((d) => d?.code ?? '--')],
  ];
}

/**
 * The summary counts as label/value pairs, in the order the report prints them.
 * One list, so the CSV row and the workbook caption cannot disagree about which
 * counts exist or what they are called.
 *
 * Spelled out — "Half Day", not "HD". The status row has to abbreviate because
 * a day column is five characters wide; the summary strip has the whole width
 * of the sheet and no reason to make anybody decode it.
 */
export function monthPerformanceSummaryPairs(row: MonthPerformanceRow): Array<[string, string]> {
  return [
    ['Present', String(row.totals.present)],
    ['Half Day', String(row.totals.halfDay)],
    ['Weekly Off', String(row.totals.weeklyOff)],
    ['Holiday', String(row.totals.holiday)],
    ['Paid Leave', String(row.totals.paidLeave)],
    ['Leave Without Pay', String(row.totals.unpaidLeave)],
    ['Absent', String(row.totals.absent)],
    ['Total Hours', fmtMinutes(row.totals.workMinutes)],
  ];
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
