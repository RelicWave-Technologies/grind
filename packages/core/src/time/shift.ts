import {
  WEEKDAYS,
  addDays,
  hhmmToMin,
  localDayWindowInTimeZone,
  possibleInstantsForZonedDateTime,
  weekdayForDate,
  type ShiftSchedule,
} from '@grind/types';

/**
 * Which shift applied on a date, and its real start and end instants.
 *
 * Always the assignment in force ON THAT DATE — a person moved from the day
 * shift to the evening shift last week is judged against the day shift for
 * last month. A shift whose end is not after its start runs overnight and ends
 * on the next calendar date.
 */

export interface ShiftAssignmentLike {
  shiftId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  shiftNameSnapshot?: string | null;
  scheduleSnapshot: unknown;
  bufferMinSnapshot?: number | null;
}

export interface ShiftTimes {
  /** HH:MM as scheduled. */
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  /** The shift ends on the next calendar date. */
  overnight: boolean;
}

export interface ShiftDay<A extends ShiftAssignmentLike = ShiftAssignmentLike> extends ShiftTimes {
  assignment: A;
  shiftId: string;
  name: string;
}

/** The assignment in force on `date`: latest start among those covering the day. */
export function assignmentForDate<A extends ShiftAssignmentLike>(
  assignments: readonly A[],
  date: string,
  tz: string,
): A | null {
  if (assignments.length === 0) return null;
  const win = localDayWindowInTimeZone(date, tz);
  if (!win) return null;
  const startMs = win.start.getTime();
  const endMs = win.end.getTime();
  let best: A | null = null;
  for (const a of assignments) {
    if (a.effectiveFrom.getTime() >= endMs) continue;
    if (a.effectiveTo !== null && a.effectiveTo.getTime() <= startMs) continue;
    if (!best || a.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = a;
  }
  return best;
}

/**
 * A wall-clock minute on a date as a real instant. A time skipped by a
 * spring-forward resolves to the first instant after the gap; a repeated
 * fall-back time resolves to its earlier occurrence.
 */
export function instantForLocalMinute(date: string, minuteOfDay: number, tz: string): number | null {
  const [year, month, day] = date.split('-').map((n) => Number.parseInt(n, 10));
  if (!year || !month || !day) return null;
  for (let m = minuteOfDay; m < minuteOfDay + 180 && m < 24 * 60; m += 1) {
    const candidates = possibleInstantsForZonedDateTime(
      { year, month, day, hour: Math.floor(m / 60), minute: m % 60, second: 0 },
      tz,
    );
    if (candidates.length > 0) return candidates[0]!.getTime();
  }
  return null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/u;

/**
 * A stored schedule snapshot, read leniently: the write-side schema forbids a
 * shift that ends after midnight, but a snapshot that holds one is still a
 * real night shift and is read as one rather than discarded.
 */
export function readSchedule(value: unknown): ShiftSchedule | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const out: Record<string, { start: string; end: string } | null> = {};
  for (const key of WEEKDAYS) {
    const day = raw[key];
    if (day === null || day === undefined) {
      out[key] = null;
      continue;
    }
    if (typeof day !== 'object') return null;
    const { start, end } = day as { start?: unknown; end?: unknown };
    if (typeof start !== 'string' || typeof end !== 'string' || !HHMM.test(start) || !HHMM.test(end)) return null;
    if (start === end) return null;
    out[key] = { start, end };
  }
  return out as ShiftSchedule;
}

/** Start/end instants for one date under a weekly schedule; null on a day off. */
export function shiftTimesFromSchedule(
  schedule: ShiftSchedule,
  date: string,
  tz: string,
): ShiftTimes | null {
  const day = schedule[weekdayForDate(date)];
  if (!day) return null;
  const startMin = hhmmToMin(day.start);
  const endMin = hhmmToMin(day.end);
  const overnight = endMin <= startMin;
  const startMs = instantForLocalMinute(date, startMin, tz);
  const endMs = instantForLocalMinute(overnight ? addDays(date, 1) : date, endMin, tz);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return { start: day.start, end: day.end, startMs, endMs, overnight };
}

/**
 * The shift that applied on `date`, or null when nobody was scheduled: no
 * assignment, an assignment without a shift, an unreadable schedule, or a day
 * off in it.
 */
export function shiftWindowFor<A extends ShiftAssignmentLike>(
  assignments: readonly A[],
  date: string,
  tz: string,
): ShiftDay<A> | null {
  const assignment = assignmentForDate(assignments, date, tz);
  if (!assignment?.shiftId) return null;
  const schedule = readSchedule(assignment.scheduleSnapshot);
  if (!schedule) return null;
  const times = shiftTimesFromSchedule(schedule, date, tz);
  if (!times) return null;
  return {
    ...times,
    assignment,
    shiftId: assignment.shiftId,
    name: assignment.shiftNameSnapshot ?? 'Shift',
  };
}
