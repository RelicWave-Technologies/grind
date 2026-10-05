import { ATTENDANCE_RULE_DEFAULTS, type DayStatus, type ShiftStatus } from '@grind/types';

/**
 * The facts a day is judged on — late, full, half — with one definition each,
 * shared by the reports, the team rollups and the month report.
 *
 * **Late** is the first real *tracked* activity (agent-observed work or a
 * meeting; never manual time) starting after the shift start plus the
 * company's grace. The shift is the one assigned for that date. A day nobody
 * expected you at the start of — a holiday, a weekly off, full-day leave, or
 * leave for the first half — is never late.
 *
 * **Full day** is 7 h of counted time, **half day** 3 h 30, unless the leave
 * policy names its own minimums.
 */

export const FULL_DAY_MINUTES: number = ATTENDANCE_RULE_DEFAULTS.fullDayMinMinutes;
export const HALF_DAY_MINUTES: number = ATTENDANCE_RULE_DEFAULTS.halfDayMinMinutes;
export const DEFAULT_LATE_GRACE_MINUTES: number = ATTENDANCE_RULE_DEFAULTS.lateGraceMinutes;

export type LateStatusFacts = Pick<DayStatus, 'kind' | 'portion'>;

/** Was nobody expected at the shift start on this day? */
export function lateExempt(status: LateStatusFacts | null | undefined): boolean {
  if (!status) return false;
  switch (status.kind) {
    case 'WORKING':
      return false;
    case 'PAID_LEAVE':
    case 'UNPAID_LEAVE':
      // Leave for the afternoon still expects you at the start of the shift.
      return status.portion !== 'SECOND_HALF';
    default:
      // HOLIDAY, WEEKLY_OFF, NO_SHIFT.
      return true;
  }
}

export interface LateFacts {
  /** First tracked activity that began on the day (see `DayBucket.firstTracked`). */
  firstTrackedMs: number | null;
  /** The assigned shift's start on that date, or null when none applied. */
  shiftStartMs: number | null;
  /** Company grace after the shift start. Defaults to 30 minutes. */
  graceMinutes?: number | null;
  /** What the Working Calendar says about the day, when known. */
  status?: LateStatusFacts | null;
}

export function isLate(facts: LateFacts): boolean {
  if (facts.firstTrackedMs === null || facts.shiftStartMs === null) return false;
  if (lateExempt(facts.status)) return false;
  const grace = Math.max(0, facts.graceMinutes ?? DEFAULT_LATE_GRACE_MINUTES);
  return facts.firstTrackedMs > facts.shiftStartMs + grace * 60_000;
}

export type DayCredit = 'FULL' | 'HALF' | 'NONE';

export interface DayThresholds {
  fullDayMinutes: number;
  halfDayMinutes: number;
}

export const DEFAULT_DAY_THRESHOLDS: DayThresholds = {
  fullDayMinutes: FULL_DAY_MINUTES,
  halfDayMinutes: HALF_DAY_MINUTES,
};

/** How much of a day this many counted minutes is worth. */
export function dayCredit(minutes: number, thresholds: DayThresholds = DEFAULT_DAY_THRESHOLDS): DayCredit {
  const m = Math.max(0, minutes);
  if (m >= thresholds.fullDayMinutes) return 'FULL';
  if (m >= thresholds.halfDayMinutes) return 'HALF';
  return 'NONE';
}

/**
 * The arrival label a report prints for a day.
 *
 *  - `no_shift`     no shift applied, or the day was off for the whole day
 *  - `no_activity`  a day somebody was expected and nothing was counted
 *  - `early`        tracked activity began before the shift start
 *  - `late`         see {@link isLate}
 *  - `on_time`      anything else with counted time
 */
export function shiftStatusFor(input: {
  shiftStartMs: number | null;
  firstTrackedMs: number | null;
  countedMs: number;
  graceMinutes?: number | null;
  status?: (LateStatusFacts & Partial<Pick<DayStatus, 'expectedFraction'>>) | null;
  /**
   * Whether the attendance rules counted this day as a late arrival, when the
   * rules are on. They apply {@link isLate} and then leave out what they do
   * not judge (an exempt person, a corrected day, today), so the label reads
   * Late exactly when the month sheet counts one.
   */
  late?: boolean;
}): ShiftStatus {
  if (input.shiftStartMs === null) return 'no_shift';
  const offAllDay = input.status
    ? input.status.kind === 'HOLIDAY'
      || input.status.kind === 'WEEKLY_OFF'
      || input.status.kind === 'NO_SHIFT'
      || input.status.expectedFraction === 0
    : false;
  if (input.countedMs <= 0) return offAllDay ? 'no_shift' : 'no_activity';
  if (input.firstTrackedMs === null) return 'on_time';
  if (input.late !== undefined) {
    if (input.late) return 'late';
    return input.firstTrackedMs < input.shiftStartMs ? 'early' : 'on_time';
  }
  if (input.firstTrackedMs < input.shiftStartMs) return 'early';
  return isLate({
    firstTrackedMs: input.firstTrackedMs,
    shiftStartMs: input.shiftStartMs,
    graceMinutes: input.graceMinutes,
    status: input.status,
  })
    ? 'late'
    : 'on_time';
}
