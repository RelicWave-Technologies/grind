import { dateKeyInTimeZone, instantForZonedDateTime } from '@grind/types';

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

export function fmtRange(startMs: number, endMs: number, timeZone: string): string {
  return `${fmtTime(startMs, timeZone)} – ${fmtTime(endMs, timeZone)}`;
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

/** Shift a YYYY-MM-DD string by a number of calendar days. */
export function addDays(yyyyMmDd: string, delta: number): string {
  const d = parseDateKey(yyyyMmDd);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function todayKey(timeZone: string): string {
  return dateKeyInTimeZone(new Date(), timeZone);
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year!, month! - 1, day!, 12));
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
