import { localDayWindow } from './day';
import {
  groupInvalidationsByUser,
  subtractInvalidations,
  type TimeInvalidationInput,
} from './invalidations';

export interface TimesheetSegmentInput {
  userId: string;
  /** TimeEntry.source — AUTO becomes WORK/MEETING by segment.kind; MANUAL collapses to MANUAL regardless. */
  source: 'AUTO' | 'MANUAL';
  segmentKind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED';
  startedAt: number;
  endedAt: number;
}

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
}

export interface TimesheetMatrix {
  from: string;
  to: string;
  tz: string;
  days: string[]; // YYYY-MM-DD inclusive
  /** Per-user, per-day. Missing entries imply zero. */
  cells: Record<string, Record<string, TimesheetCell>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Add `delta` days to a YYYY-MM-DD string. */
export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD strings from `from` to `to`. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  // Hard cap at 366 to short-circuit pathological input — the route caps at 60.
  for (let i = 0; i < 367; i++) {
    out.push(cur);
    if (cur === to) return out;
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * Aggregate TimeSegment durations into a per-user × per-day matrix, clipped
 * to each local-day window and bucketed by kind. IDLE_TRIMMED contributes
 * nothing (it's *not* worked time — that's the whole point of the trim).
 *
 * MANUAL entries collapse to `manualMs` regardless of segment.kind because
 * the user-facing semantic is "this came from an approved request, not from
 * live tracking" — segment.kind on a MANUAL entry is always WORK anyway.
 */
export function buildTimesheetMatrix(input: {
  from: string;
  to: string;
  tz: string;
  segments: TimesheetSegmentInput[];
  invalidations?: TimeInvalidationInput[];
}): TimesheetMatrix | null {
  const fromWin = localDayWindow(input.from, input.tz);
  const toWin = localDayWindow(input.to, input.tz);
  if (!fromWin || !toWin) return null;
  if (toWin.end <= fromWin.start) return null;

  const days = dateRange(input.from, input.to);
  // Pre-compute every day's window so we don't call localDayWindow per segment.
  const dayWindows: Array<{ key: string; startMs: number; endMs: number }> = [];
  for (const day of days) {
    const w = localDayWindow(day, input.tz);
    if (!w) return null;
    dayWindows.push({ key: day, startMs: w.start.getTime(), endMs: w.end.getTime() });
  }
  const rangeStart = dayWindows[0]!.startMs;
  const rangeEnd = dayWindows[dayWindows.length - 1]!.endMs;

  const cells: Record<string, Record<string, TimesheetCell>> = {};
  const invalidationsByUser = groupInvalidationsByUser(input.invalidations);
  const ensure = (userId: string, day: string): TimesheetCell => {
    let perUser = cells[userId];
    if (!perUser) {
      perUser = {};
      cells[userId] = perUser;
    }
    let cell = perUser[day];
    if (!cell) {
      cell = {
        workedMs: 0,
        meetingMs: 0,
        manualMs: 0,
        invalidatedMs: 0,
        totalMs: 0,
        firstActivityMs: null,
        lastActivityMs: null,
        activitySampleCount: 0,
      };
      perUser[day] = cell;
    }
    return cell;
  };

  for (const s of input.segments) {
    if (s.endedAt <= s.startedAt) continue;
    if (s.endedAt <= rangeStart || s.startedAt >= rangeEnd) continue;
    if (s.segmentKind === 'IDLE_TRIMMED') continue;

    // Binary search would be neat but linear scan is fine for <=60 days.
    for (const dw of dayWindows) {
      if (s.endedAt <= dw.startMs) break; // segments are time-ordered? not guaranteed; can't rely on this
      if (s.startedAt >= dw.endMs) continue;
      const start = Math.max(s.startedAt, dw.startMs);
      const end = Math.min(s.endedAt, dw.endMs);
      if (end <= start) continue;
      const cell = ensure(s.userId, dw.key);
      const { valid, invalidatedMs } = subtractInvalidations(invalidationsByUser, s.userId, start, end);
      cell.invalidatedMs += invalidatedMs;
      for (const part of valid) {
        const dur = part.end - part.start;
        if (s.source === 'MANUAL') cell.manualMs += dur;
        else if (s.segmentKind === 'MEETING') cell.meetingMs += dur;
        else cell.workedMs += dur;
        cell.totalMs += dur;
        if (cell.firstActivityMs === null || part.start < cell.firstActivityMs) cell.firstActivityMs = part.start;
        if (cell.lastActivityMs === null || part.end > cell.lastActivityMs) cell.lastActivityMs = part.end;
      }
    }
  }

  return { from: input.from, to: input.to, tz: input.tz, days, cells };
}

/** Helper exposed for tests + a deterministic helper for the route layer. */
export const TIMESHEETS_DAY_MS = DAY_MS;
