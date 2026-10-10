import { emptyDayBucket, type DayBucket } from '@grind/core';
import { dateKeysBetween, type DayStatus } from '@grind/types';

export interface TimesheetCell {
  workedMs: number;
  meetingMs: number;
  manualMs: number;
  invalidatedMs: number;
  totalMs: number;
  /**
   * Earliest / latest tracked moment in this user-day (in the rendering tz's
   * local-day window). null = no tracked time. Powers the attendance view's
   * "first activity 9:14 AM, last 5:42 PM" badges + CSV export.
   */
  firstActivityMs: number | null;
  lastActivityMs: number | null;
  /** Number of one-minute activity samples captured inside this user-day. */
  activitySampleCount: number;
  /**
   * What the Working Calendar says about this user-day — was work expected,
   * and if not, was it a holiday, a weekly off or approved leave.
   *
   * Carried on the cell so every consumer of the matrix (attendance, member
   * reports, the month report, MCP) gets leave without each one re-deriving it, and
   * without four subtly different answers to "was this person meant to be
   * here". `null` when the caller did not supply a calendar.
   */
  dayStatus?: DayStatus | null;
}

export interface TimesheetMatrix {
  from: string;
  to: string;
  tz: string;
  days: string[]; // YYYY-MM-DD inclusive
  /** Per-user, per-day. Missing entries imply zero. */
  cells: Record<string, Record<string, TimesheetCell>>;
}

/** Inclusive list of YYYY-MM-DD strings from `from` to `to` (capped at 367). */
export function dateRange(from: string, to: string): string[] {
  return dateKeysBetween(from, to, 367);
}

function cellOf(bucket: DayBucket, dayStatus: DayStatus | null): TimesheetCell {
  return {
    workedMs: bucket.worked,
    meetingMs: bucket.meeting,
    manualMs: bucket.manual,
    invalidatedMs: bucket.invalidated,
    totalMs: bucket.counted,
    firstActivityMs: bucket.first,
    lastActivityMs: bucket.last,
    activitySampleCount: 0,
    dayStatus,
  };
}

/** A user-day with no time and no calendar status. */
export function emptyTimesheetCell(): TimesheetCell {
  return cellOf(emptyDayBucket(), null);
}

/**
 * The matrix from day buckets already attributed by `@grind/core`'s
 * `bucketByDay` — the same buckets every other surface reads, so a cell here
 * cannot disagree with Edit Time or the reports.
 */
export function timesheetMatrixFromBuckets(input: {
  from: string;
  to: string;
  tz: string;
  days: string[];
  buckets: ReadonlyMap<string, ReadonlyMap<string, DayBucket>>;
  dayStatusFor?: (userId: string, date: string) => DayStatus | null;
  userIds?: readonly string[];
}): TimesheetMatrix {
  const cells: Record<string, Record<string, TimesheetCell>> = {};
  const put = (userId: string, date: string, bucket: DayBucket) => {
    (cells[userId] ??= {})[date] = cellOf(bucket, input.dayStatusFor?.(userId, date) ?? null);
  };
  for (const [userId, perDay] of input.buckets) {
    for (const [date, bucket] of perDay) {
      if (bucket.counted > 0 || bucket.invalidated > 0) put(userId, date, bucket);
    }
  }

  // Days a person was absent carry no time, so nothing above created a cell
  // for them. Materialise those now — a week of leave must not read as a week
  // of silence.
  if (input.dayStatusFor && input.userIds) {
    for (const userId of input.userIds) {
      for (const date of input.days) {
        if (cells[userId]?.[date]) continue;
        const status = input.dayStatusFor(userId, date);
        if (!status || status.kind === 'WORKING' || status.kind === 'NO_SHIFT') continue;
        put(userId, date, emptyDayBucket());
      }
    }
  }

  return { from: input.from, to: input.to, tz: input.tz, days: input.days, cells };
}
