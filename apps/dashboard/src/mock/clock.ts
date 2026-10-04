/**
 * Calendar helpers for the mock. Every fixture is generated relative to the
 * real current date in the workspace timezone, so the screens always read as
 * "today", "this week" and "this month" without hardcoded dates.
 */
import { dateKeyInTimeZone, instantForZonedDateTime, localDayWindowInTimeZone, zonedDateTimeParts } from '@grind/types';
import type { Weekday } from '@grind/types/shifts';

export const TZ = 'Asia/Kolkata';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function todayKey(): string {
  return dateKeyInTimeZone(Date.now(), TZ);
}

export function dateKeyOf(ms: number): string {
  return dateKeyInTimeZone(ms, TZ);
}

export function addDays(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map((n) => Number.parseInt(n, 10));
  const date = new Date(Date.UTC(y!, m! - 1, d! + delta, 12));
  return date.toISOString().slice(0, 10);
}

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive list of YYYY-MM-DD keys. */
export function daysInRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

export function dayWindow(key: string): { start: number; end: number } {
  const win = localDayWindowInTimeZone(key, TZ);
  if (!win) throw new Error(`mock: bad date ${key}`);
  return { start: win.start.getTime(), end: win.end.getTime() };
}

/** Epoch ms for a wall-clock minute-of-day on a workspace date. */
export function atMinute(key: string, minuteOfDay: number): number {
  const [y, m, d] = key.split('-').map((n) => Number.parseInt(n, 10));
  const hour = Math.floor(minuteOfDay / 60);
  const minute = Math.round(minuteOfDay % 60);
  if (hour >= 24) return dayWindow(key).end + (minuteOfDay - 24 * 60) * MIN;
  return instantForZonedDateTime({ year: y!, month: m!, day: d!, hour, minute, second: 0 }, TZ).getTime();
}

export function hhmmToMinute(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => Number.parseInt(n, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minuteOfDay(ms: number): number {
  const p = zonedDateTimeParts(ms, TZ);
  return p.hour * 60 + p.minute;
}

const WEEKDAY_KEYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function weekdayOf(key: string): Weekday {
  const [y, m, d] = key.split('-').map((n) => Number.parseInt(n, 10));
  return WEEKDAY_KEYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

export function isWeekend(key: string): boolean {
  const w = weekdayOf(key);
  return w === 'sat' || w === 'sun';
}

/** First weekday on or after `key`. */
export function nextWeekday(key: string): string {
  let d = key;
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
}

/** Last weekday on or before `key`. */
export function prevWeekday(key: string): string {
  let d = key;
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

export function monthOf(key: string): string {
  return key.slice(0, 7);
}

export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A point in the past relative to now, as ISO. */
export function agoIso(ms: number): string {
  return iso(Date.now() - ms);
}

/** Midday instant of a date, handy for createdAt-style stamps. */
export function noonOf(key: string): number {
  return atMinute(key, 12 * 60);
}

export function isValidDateKey(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
