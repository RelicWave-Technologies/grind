import { addDays, dateKeyInTimeZone, instantForZonedDateTime, todayKey, weekdayForDate, type Weekday } from '@grind/types';

/** Calendar-key arithmetic is the shared one in @grind/types. */
export { addDays, todayKey };

/** The weekday an instant falls on in a business timezone. */
export function weekdayInTimeZone(date: Date, timeZone: string): Weekday {
  return weekdayForDate(dateKeyInTimeZone(date, timeZone));
}

/**
 * Tiny time/duration formatters for the dashboard. Match the agent's
 * conventions (12h clock, "Xh Ym", "·" separators) so an employee
 * switching between the desktop tracker and the web dashboard sees
 * the same numbers in the same shape.
 */

export function fmtTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(ms));
}

/**
 * A time of day held as minutes since local midnight — not an instant, so it
 * carries no timezone of its own. Used for range summaries like "typically
 * punches in around 09:45", where the answer is a clock reading rather than a
 * moment. Rendered on the same 12h clock as `fmtTime` so the two read alike.
 */
export function fmtMinuteOfDay(minute: number): string {
  const d = new Date(Date.UTC(2000, 0, 1, Math.floor(minute / 60), minute % 60));
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(d);
}

/** A shift's wall-clock "HH:MM" on the 12h clock, e.g. "9:30 AM". */
export function fmtShiftClock(hhmm: string): string {
  const [hourRaw, minuteRaw] = hhmm.split(':').map((part) => Number.parseInt(part, 10));
  const hour24 = hourRaw ?? 0;
  const minute = minuteRaw ?? 0;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function fmtDateShort(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(new Date(ms));
}

export function fmtDurationMs(ms: number): string {
  if (ms <= 0) return '0m';
  if (ms < 60_000) return '<1m'; // honest about sub-minute slivers (no misleading "0m")
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Today / Yesterday / "Sat, May 30". */
export function fmtDayLabel(yyyyMmDd: string, timeZone: string): string {
  const today = todayKey(timeZone);
  if (yyyyMmDd === today) return 'Today';
  if (yyyyMmDd === addDays(today, -1)) return 'Yesterday';
  const d = calendarDateInstant(yyyyMmDd, timeZone);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(d);
}

/** A formatting-only local-noon instant. Noon is valid through DST changes,
 * so a YYYY-MM-DD label cannot roll into a neighboring business date. */
export function calendarDateInstant(key: string, timeZone: string): Date {
  const [year, month, day] = key.split('-').map((part) => Number.parseInt(part, 10));
  return instantForZonedDateTime({ year: year!, month: month!, day: day!, hour: 12, minute: 0, second: 0 }, timeZone);
}

/**
 * Short relative age ("3m ago", "2h ago", "4d ago", "3w ago"). Designed
 * for queue rows where space is tight and the exact minute doesn't
 * matter — pairs well with a full timestamp tooltip.
 */
export function fmtAgeShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}
