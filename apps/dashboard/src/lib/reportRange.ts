/**
 * THE month rule — the period every dashboard screen that lists a period of
 * records opens on (Reports, Approvals, Attendance, the Team and Teams
 * drawers), and the key their route-loader prefetch uses. Change it here only.
 *
 * The range a report opens on, following payroll timing.
 *
 * Payroll for a month is closed in the first days of the next one, so up to
 * and including PAYROLL_CLOSE_DAY the month people are still settling is the
 * PREVIOUS one: a report opened on the 1st–10th shows that whole month (1st to
 * its last day). From the 11th the current month is the one in play, so the
 * report shows it so far (1st to today).
 *
 * `today` is a YYYY-MM-DD key already in the workspace timezone (todayKey(tz)),
 * so the boundary falls at the workspace's midnight, not UTC's.
 */
export const PAYROLL_CLOSE_DAY = 10;

export interface DateRange {
  from: string;
  to: string;
}

export function defaultReportRange(today: string): DateRange {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  if (day > PAYROLL_CLOSE_DAY) return { from: dateKey(year, month, 1), to: today };
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return {
    from: dateKey(prevYear, prevMonth, 1),
    to: dateKey(prevYear, prevMonth, daysInMonth(prevYear, prevMonth)),
  };
}

/** The month (YYYY-MM) a month view opens on: the month defaultReportRange covers. */
export function defaultReportMonth(today: string): string {
  return defaultReportRange(today).from.slice(0, 7);
}

/** `month` (YYYY-MM) moved by `delta` months. */
export function addMonths(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(year, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A whole month as a range — cut at today while it is still running. */
export function monthRange(month: string, today: string): DateRange {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const to = dateKey(year, m, daysInMonth(year, m));
  return { from: dateKey(year, m, 1), to: to > today ? today : to };
}

/** The `days`-long range that ends on `to`. */
export function trailingRange(to: string, days: number): DateRange {
  return { from: shiftDay(to, -(days - 1)), to };
}

/**
 * The previous (-1) or next (+1) period from `range`: a whole calendar month
 * for a month span, else the same number of days. Never runs past today.
 */
export function stepRange(range: DateRange, span: 'month' | number, dir: -1 | 1, today: string): DateRange {
  if (span === 'month') return monthRange(addMonths(range.to.slice(0, 7), dir), today);
  const to = shiftDay(range.to, dir * span);
  return trailingRange(to > today ? today : to, span);
}

/** Days in a 1-based month (Date.UTC's day 0 is the previous month's last day). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftDay(key: string, delta: number): string {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10);
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
