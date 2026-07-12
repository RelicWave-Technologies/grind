import { z } from 'zod';

export const DEFAULT_TIME_ZONE = 'UTC';

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

export interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

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

/** Convert a workspace-local wall clock to an absolute instant, including DST offsets. */
export function instantForZonedDateTime(parts: ZonedDateTimeParts, timeZone: string): Date {
  if (!isValidTimeZone(timeZone)) throw new Error('invalid_timezone');
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const seenParts = zonedDateTimeParts(guess, timeZone);
    const seen = Date.UTC(
      seenParts.year,
      seenParts.month - 1,
      seenParts.day,
      seenParts.hour,
      seenParts.minute,
      seenParts.second,
    );
    const delta = seen - target;
    if (delta === 0) return new Date(guess);
    guess -= delta;
  }
  return new Date(guess);
}

/** Calendar date for an instant in an explicit business timezone. */
export function dateKeyInTimeZone(value: Date | number | string, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(timeZone)) {
    throw new Error('invalid_date_or_timezone');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
