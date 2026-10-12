/**
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

/** Days in a 1-based month (Date.UTC's day 0 is the previous month's last day). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
