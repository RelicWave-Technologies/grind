import { zonedDateTimeParts } from '@grind/types';
import { OFFSET_DRIFT } from './tzIds';

/**
 * The zones the dense tables are built over: the tricky ones (30-minute and
 * 45-minute offsets, 30-minute DST, the date line, a skipped day, midnight DST
 * changes, negative DST, post-2037 rules, no DST at all), the ones the product
 * is used in, and aliases.
 */
export const DENSE_ZONES: readonly string[] = [
  'UTC', 'Etc/UTC', 'GMT', 'Etc/GMT+5', 'Etc/GMT-14', 'Etc/GMT+12', 'Etc/GMT-1',
  'Asia/Kolkata', 'Asia/Calcutta', 'Asia/Kathmandu', 'Asia/Kabul', 'Asia/Yangon', 'Asia/Colombo', 'Asia/Tehran',
  'Asia/Dubai', 'Asia/Dhaka', 'Asia/Karachi', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Pyongyang',
  'Asia/Jerusalem', 'Asia/Beirut', 'Asia/Gaza', 'Africa/Cairo', 'Africa/Casablanca', 'Africa/Lagos', 'Africa/Johannesburg',
  'Africa/Windhoek', 'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'Europe/Istanbul',
  'Atlantic/Azores', 'America/Sao_Paulo', 'America/St_Johns', 'America/Havana', 'America/Santiago', 'America/Mexico_City',
  'America/Caracas', 'America/Nuuk', 'America/New_York', 'US/Eastern', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Pacific/Apia', 'Pacific/Chatham', 'Pacific/Auckland',
  'Pacific/Kiritimati', 'Pacific/Tongatapu', 'Pacific/Norfolk', 'Australia/Lord_Howe', 'Australia/Sydney', 'Australia/Adelaide',
  'Australia/Darwin', 'Antarctica/Troll', 'Pacific/Fiji', 'America/Godthab', 'IST', 'EST', 'CET', '+05:30', '-03:30', '+14:00',
].filter((id) => !OFFSET_DRIFT.includes(id));

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const FROM_2015 = Date.UTC(2015, 0, 1);
export const TO_2036 = Date.UTC(2036, 0, 1);

/** The UTC offset in seconds at an instant in seconds, read through the real `zonedDateTimeParts`. */
export function offsetAt(timeZone: string, seconds: number): number {
  const p = zonedDateTimeParts(seconds * 1000, timeZone);
  return Math.round(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000) - seconds;
}

/**
 * Every offset change in [from, to] as `[firstSecondOfTheNewOffset, offset]`,
 * starting with `[from, offset at from]`. Found by stepping `stepDays` and
 * bisecting to the second, so two changes inside one step are missed, and the
 * Rust test scans the same way so it misses the same ones.
 */
export function offsetTransitions(timeZone: string, from: number, to: number, stepDays: number): Array<[number, number]> {
  let previous = offsetAt(timeZone, from);
  const list: Array<[number, number]> = [[from, previous]];
  for (let t = from + stepDays * 86_400; t <= to; t += stepDays * 86_400) {
    const offset = offsetAt(timeZone, t);
    if (offset === previous) continue;
    let low = t - stepDays * 86_400;
    let high = t;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (offsetAt(timeZone, mid) === previous) low = mid;
      else high = mid;
    }
    list.push([high, offset]);
    previous = offset;
  }
  return list;
}

export interface Transition {
  zone: string;
  /** The instant (ms) the offset changes. */
  at: number;
  /** Offsets in ms before and after. */
  before: number;
  after: number;
}

/** Every transition of the dense zones between 2015 and 2036. */
export function denseTransitions(): Transition[] {
  const found: Transition[] = [];
  for (const zone of DENSE_ZONES) {
    const list = offsetTransitions(zone, FROM_2015 / 1000, TO_2036 / 1000, 1);
    for (let i = 1; i < list.length; i++) {
      found.push({ zone, at: list[i]![0] * 1000, before: list[i - 1]![1] * 1000, after: list[i]![1] * 1000 });
    }
  }
  return found;
}
