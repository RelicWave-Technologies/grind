import { localDayWindowInTimeZone } from '@grind/types';
import { clipInterval, mergeIntervals, type Interval } from './intervals';
import { isCounted, type TimelinePiece } from './timeline';

/**
 * Attribute a resolved timeline to workspace calendar days.
 *
 * Each day is its real local window — 23, 24 or 25 hours — and a piece that
 * crosses midnight is split between the two days it touches.
 */

export interface DayWindow {
  date: string;
  start: number;
  end: number;
}

export interface DayBucket {
  /** Tracked work, not invalidated. */
  worked: number;
  /** Tracked meetings, not invalidated. */
  meeting: number;
  /** Approved manual time that survived the overlap rule, not invalidated. */
  manual: number;
  /** Trimmed idle — drawn, never counted. */
  idle: number;
  /** Work, meeting or manual time a reviewer invalidated. */
  invalidated: number;
  /** worked + meeting + manual: the day's total. */
  counted: number;
  /**
   * First counted stretch (tracked or manual) that began on this day. A
   * stretch that started yesterday and ran past midnight is a continuation,
   * not a start.
   */
  first: number | null;
  /** End of the last counted time on this day (clipped to the day). */
  last: number | null;
}

export function emptyDayBucket(): DayBucket {
  return {
    worked: 0,
    meeting: 0,
    manual: 0,
    idle: 0,
    invalidated: 0,
    counted: 0,
    first: null,
    last: null,
  };
}

/** Real windows for calendar keys in a timezone. Unresolvable keys are skipped. */
export function dayWindowsFor(days: readonly string[], tz: string): DayWindow[] {
  const out: DayWindow[] = [];
  for (const date of days) {
    const win = localDayWindowInTimeZone(date, tz);
    if (win) out.push({ date, start: win.start.getTime(), end: win.end.getTime() });
  }
  return out;
}

/** Start of the first merged stretch of `intervals` that begins inside `[lo, hi)`. */
export function firstStretchStartWithin(merged: readonly Interval[], lo: number, hi: number): number | null {
  for (const iv of merged) {
    if (iv.start >= hi) return null;
    if (iv.start >= lo) return iv.start;
  }
  return null;
}

/**
 * userId → date → bucket. Every requested day exists for every user that has a
 * piece anywhere; pass the pieces with lookback (a day before the range) so a
 * stretch running into the first day is recognised as a continuation.
 */
export function bucketByDay(
  pieces: ReadonlyArray<TimelinePiece<unknown>>,
  tz: string,
  days: readonly string[],
): Map<string, Map<string, DayBucket>> {
  const windows = dayWindowsFor(days, tz).sort((a, b) => a.start - b.start);
  const byUser = new Map<string, Array<TimelinePiece<unknown>>>();
  for (const piece of pieces) {
    const list = byUser.get(piece.userId) ?? [];
    list.push(piece);
    byUser.set(piece.userId, list);
  }

  const out = new Map<string, Map<string, DayBucket>>();
  for (const [userId, unsorted] of byUser) {
    // One owner per instant: sorted by start, the pieces are also sorted by
    // end, so each day only has to look at the pieces from a moving cursor.
    const list = [...unsorted].sort((a, b) => a.start - b.start || a.end - b.end);
    const counted = mergeIntervals(list.filter(isCounted));
    const perDay = new Map<string, DayBucket>();
    let cursor = 0;
    for (const day of windows) {
      while (cursor < list.length && list[cursor]!.end <= day.start) cursor += 1;
      const bucket = emptyDayBucket();
      for (let i = cursor; i < list.length && list[i]!.start < day.end; i += 1) {
        const piece = list[i]!;
        const iv = clipInterval(piece, day.start, day.end);
        if (!iv) continue;
        const ms = iv.end - iv.start;
        if (piece.kind === 'IDLE') {
          bucket.idle += ms;
          continue;
        }
        if (piece.invalidated) {
          bucket.invalidated += ms;
          continue;
        }
        if (piece.kind === 'WORK') bucket.worked += ms;
        else if (piece.kind === 'MEETING') bucket.meeting += ms;
        else bucket.manual += ms;
        bucket.counted += ms;
        if (bucket.last === null || iv.end > bucket.last) bucket.last = iv.end;
      }
      bucket.first = firstStretchStartWithin(counted, day.start, day.end);
      perDay.set(day.date, bucket);
    }
    out.set(userId, perDay);
  }
  return out;
}

/** The bucket for one user-day, or an empty one. */
export function bucketFor(
  buckets: ReadonlyMap<string, ReadonlyMap<string, DayBucket>>,
  userId: string,
  date: string,
): DayBucket {
  return buckets.get(userId)?.get(date) ?? emptyDayBucket();
}
