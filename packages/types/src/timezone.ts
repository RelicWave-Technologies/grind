import { z } from 'zod';
import { WEEKDAYS, type Weekday } from './shifts';

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

const MAX_TIME_ZONE_CACHE_ENTRIES = 128;
const MAX_DAY_WINDOW_CACHE_ENTRIES = 512;
const validTimeZones = new Map<string, boolean>();
const zonedPartsFormatters = new Map<string, Intl.DateTimeFormat>();
const localDayWindows = new Map<string, { startMs: number; endMs: number } | null>();

function cacheBounded<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): V {
  if (!cache.has(key) && cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
  return value;
}

export function isValidTimeZone(value: string): boolean {
  const cached = validTimeZones.get(value);
  if (cached !== undefined) return cached;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return cacheBounded(validTimeZones, value, true, MAX_TIME_ZONE_CACHE_ENTRIES);
  } catch {
    return cacheBounded(validTimeZones, value, false, MAX_TIME_ZONE_CACHE_ENTRIES);
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
  let formatter = zonedPartsFormatters.get(timeZone);
  if (!formatter) {
    formatter = cacheBounded(zonedPartsFormatters, timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }), MAX_TIME_ZONE_CACHE_ENTRIES);
  }
  const parts = formatter.formatToParts(date);
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
 * adding 24 hours to the first instant. When local midnight does not exist
 * (a spring-forward at 00:00) the day starts at its first existing instant.
 */
export function localDayWindowInTimeZone(
  date: string,
  timeZone: string,
): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isValidTimeZone(timeZone)) return null;
  const cacheKey = `${timeZone}\u0000${date}`;
  if (localDayWindows.has(cacheKey)) {
    const cached = localDayWindows.get(cacheKey);
    return cached ? { start: new Date(cached.startMs), end: new Date(cached.endMs) } : null;
  }
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10));
  if (!year || !month || !day) return null;

  try {
    const start = firstInstantOfLocalDate(year, month, day, timeZone);
    const nextCalendarDate = new Date(Date.UTC(year, month - 1, day + 1));
    const end = firstInstantOfLocalDate(
      nextCalendarDate.getUTCFullYear(),
      nextCalendarDate.getUTCMonth() + 1,
      nextCalendarDate.getUTCDate(),
      timeZone,
    );
    cacheBounded(localDayWindows, cacheKey, {
      startMs: start.getTime(),
      endMs: end.getTime(),
    }, MAX_DAY_WINDOW_CACHE_ENTRIES);
    return { start, end };
  } catch {
    cacheBounded(localDayWindows, cacheKey, null, MAX_DAY_WINDOW_CACHE_ENTRIES);
    return null;
  }
}

/**
 * The first real instant whose workspace-local calendar date is this date.
 *
 * Normally that is local 00:00. A few zones (Santiago, Havana, Beirut…) spring
 * forward AT midnight, so 00:00 never happens and the day starts at 01:00.
 * Rejecting those days made every report treat them as unknowable; the day
 * still exists, it is just 23 hours long and starts late.
 */
function firstInstantOfLocalDate(year: number, month: number, day: number, timeZone: string): Date {
  const midnight = possibleInstantsForZonedDateTime({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
  if (midnight.length > 0) return midnight[0]!;
  // Local noon always exists, so the day's first instant lies within the 36
  // hours before it. Search on whole minutes: zone transitions never fall
  // between them, so the answer is exact.
  const noon = instantForZonedDateTime({ year, month, day, hour: 12, minute: 0, second: 0 }, timeZone).getTime();
  const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const MINUTE = 60_000;
  let lo = noon - 36 * 60 * MINUTE; // a previous-date instant
  let hi = noon; // an instant on this date
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (mid === lo) break;
    if (dateKeyInTimeZone(mid, timeZone) === key) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
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

/**
 * The median of a set of minute-of-day readings, or null when there is nothing
 * to summarise. Nulls are skipped rather than counted as midnight.
 *
 * Used for range summaries like "typically punches in around 09:15", where the
 * answer is a clock reading rather than a moment. Median rather than mean so a
 * single odd day — one 03:00 badge-in — cannot drag the answer with it.
 *
 * Lives here rather than in either app because two callers must agree on the
 * number: the API computes it for /reports/team/summary, and the dashboard
 * recomputes it in the legacy-API fallback.
 *
 * Caveat worth naming: minute-of-day wraps at midnight, so a shift that
 * regularly ends after 00:00 summarises to an early-morning punch out. That
 * reads correctly for day shifts; night shifts would need a shift-anchored
 * window instead.
 */
export function medianMinute(minutes: Array<number | null | undefined>): number | null {
  const present = minutes
    .filter((m): m is number => typeof m === 'number')
    .sort((a, b) => a - b);
  if (present.length === 0) return null;
  const mid = Math.floor(present.length / 2);
  // Even counts average the middle pair, then round back onto a whole minute.
  return present.length % 2 === 1
    ? present[mid]!
    : Math.round((present[mid - 1]! + present[mid]!) / 2);
}

// ---------------------------------------------------------------------------
// Calendar-date (YYYY-MM-DD) arithmetic
//
// Business dates are plain calendar keys. Their arithmetic must never touch the
// host or browser timezone, so it all runs on the UTC grid where every day is
// exactly one day. One copy here, shared by the API, the agent and the
// dashboard (which may depend on @grind/types and nothing else).
// ---------------------------------------------------------------------------

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** A real YYYY-MM-DD calendar date (rejects 2026-02-30). */
export function isYmd(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * A formatting/arithmetic anchor for a calendar key: noon UTC on that date.
 * Noon keeps the calendar date stable under any offset within ±11h.
 */
export function dateKeyAnchor(key: string): Date {
  const [year, month, day] = key.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(Date.UTC(year!, month! - 1, day!, 12));
}

/** The calendar key of a UTC-grid anchor (inverse of {@link dateKeyAnchor}). */
export function anchorDateKey(anchor: Date): string {
  return anchor.toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD key by whole calendar days. */
export function addDays(key: string, delta: number): string {
  const d = dateKeyAnchor(key);
  d.setUTCDate(d.getUTCDate() + delta);
  return anchorDateKey(d);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dateKeyAnchor(to).getTime() - dateKeyAnchor(from).getTime()) / 86_400_000);
}

/** Inclusive list of calendar keys, capped so pathological input cannot spin. */
export function dateKeysBetween(from: string, to: string, maxDays = 400): string[] {
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i < maxDays; i++) {
    if (cur > to) break;
    out.push(cur);
    if (cur === to) break;
    cur = addDays(cur, 1);
  }
  return out;
}

/** Weekday key of a calendar date — the date itself, never an instant. */
export function weekdayForDate(key: string): Weekday {
  return WEEKDAYS[dateKeyAnchor(key).getUTCDay()]!;
}

/** Today's calendar key in an explicit business timezone. */
export function todayKey(timeZone: string, now: Date | number = new Date()): string {
  return dateKeyInTimeZone(now, timeZone);
}
