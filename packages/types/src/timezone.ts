import { z } from 'zod';

export const DEFAULT_TIME_ZONE = 'UTC';

export interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export class LocalTimeResolutionError extends RangeError {
  constructor(
    public readonly code: 'invalid_local_time' | 'nonexistent_local_time',
    message: string,
  ) {
    super(message);
    this.name = 'LocalTimeResolutionError';
  }
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(isValidTimeZone, { message: 'invalid_timezone' });

export type TimeZone = z.infer<typeof TimeZoneSchema>;

export function zonedDateTimeParts(value: Date | number | string, timeZone: string): ZonedDateTimeParts {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(timeZone)) {
    throw new Error('invalid_date_or_timezone');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function sameParts(a: ZonedDateTimeParts, b: ZonedDateTimeParts): boolean {
  return a.year === b.year
    && a.month === b.month
    && a.day === b.day
    && a.hour === b.hour
    && a.minute === b.minute
    && a.second === b.second;
}

function utcMillis(parts: ZonedDateTimeParts): number {
  const value = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const normalized = new Date(value);
  if (
    normalized.getUTCFullYear() !== parts.year
    || normalized.getUTCMonth() + 1 !== parts.month
    || normalized.getUTCDate() !== parts.day
    || normalized.getUTCHours() !== parts.hour
    || normalized.getUTCMinutes() !== parts.minute
    || normalized.getUTCSeconds() !== parts.second
  ) {
    throw new LocalTimeResolutionError('invalid_local_time', 'invalid_local_time');
  }
  return value;
}

/**
 * Resolve a workspace-local wall clock into the real instant(s) that display
 * that clock value. A normal clock has one candidate, a fall-back hour has
 * two, and a spring-forward gap has none.
 */
export function possibleInstantsForZonedDateTime(parts: ZonedDateTimeParts, timeZone: string): Date[] {
  if (!isValidTimeZone(timeZone)) throw new Error('invalid_timezone');
  const target = utcMillis(parts);
  const offsets = new Set<number>();
  // Both offsets around every modern DST transition occur within this window.
  // Sampling offsets, then verifying formatted candidates, avoids trusting the
  // host timezone and keeps normal-day resolution constant-sized.
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const probe = target + hours * 60 * 60 * 1000;
    const observed = zonedDateTimeParts(probe, timeZone);
    offsets.add(utcMillis(observed) - probe);
  }
  const candidates = [...offsets]
    .map((offset) => new Date(target - offset))
    .filter((candidate) => sameParts(zonedDateTimeParts(candidate, timeZone), parts))
    .sort((a, b) => a.getTime() - b.getTime());
  return candidates.filter((candidate, index) => index === 0 || candidate.getTime() !== candidates[index - 1]!.getTime());
}

/**
 * Convert a workspace-local wall clock to UTC. Nonexistent spring-forward
 * times are rejected. For the repeated fall-back hour we intentionally choose
 * the earlier occurrence; callers never inherit the browser or server zone.
 */
export function instantForZonedDateTime(parts: ZonedDateTimeParts, timeZone: string): Date {
  const candidates = possibleInstantsForZonedDateTime(parts, timeZone);
  if (candidates.length === 0) {
    throw new LocalTimeResolutionError('nonexistent_local_time', 'nonexistent_local_time');
  }
  return candidates[0]!;
}

/**
 * The real [start, end) instants for one YYYY-MM-DD on a workspace calendar.
 * A day can be 23, 24, or 25 hours long; callers must never derive this by
 * adding 24 hours to the first instant.
 */
export function localDayWindowInTimeZone(
  date: string,
  timeZone: string,
): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isValidTimeZone(timeZone)) return null;
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) return null;

  try {
    const start = instantForZonedDateTime({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
    const nextCalendarDate = new Date(Date.UTC(year, month - 1, day + 1));
    const end = instantForZonedDateTime({
      year: nextCalendarDate.getUTCFullYear(),
      month: nextCalendarDate.getUTCMonth() + 1,
      day: nextCalendarDate.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    }, timeZone);
    return { start, end };
  } catch {
    return null;
  }
}

/** Calendar date for an instant in an explicit business timezone. */
export function dateKeyInTimeZone(value: Date | number | string, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(timeZone)) {
    throw new Error('invalid_date_or_timezone');
  }
  const parts = zonedDateTimeParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}
