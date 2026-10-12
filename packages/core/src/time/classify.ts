import { ATTENDANCE_RULE_DEFAULTS, type AttendanceRuleMode, type DayStatus, type ShiftStatus } from '@grind/types';

/**
 * The facts a day is judged on — late, full, half — with one definition each,
 * shared by the reports, the team rollups and the month report.
 *
 * **Late** is judged by the door: the punch-in recorded for that date, after
 * the shift start plus the company's grace. When Timo work started does not
 * matter — somebody who badged in at 09:20 and opened the laptop at 09:33 was
 * on time. The shift is the one assigned for that date. On leave for the first
 * half you are due in the afternoon instead: late is a punch-in after one
 * fixed clock time (14:00 unless the policy names its own), with no grace. A
 * day with no punch-in is never late, and neither is a day nobody judged at
 * the shift start — a holiday, a weekly off, full-day leave, leave for the
 * second half. Only people the attendance rules treat as STANDARD can be late
 * at all.
 *
 * **Full day** is 7 h of counted time, **half day** 3 h 30, unless the leave
 * policy names its own minimums.
 */

export const FULL_DAY_MINUTES: number = ATTENDANCE_RULE_DEFAULTS.fullDayMinMinutes;
export const HALF_DAY_MINUTES: number = ATTENDANCE_RULE_DEFAULTS.halfDayMinMinutes;
export const DEFAULT_LATE_GRACE_MINUTES: number = ATTENDANCE_RULE_DEFAULTS.lateGraceMinutes;
export const DEFAULT_HALF_DAY_LATE_AFTER_MINUTE: number = ATTENDANCE_RULE_DEFAULTS.halfDayLateAfterMinute;

export type LateStatusFacts = Pick<DayStatus, 'kind' | 'portion'>;

/** Off for the morning, due in the afternoon. */
function firstHalfLeave(status: LateStatusFacts | null | undefined): boolean {
  return (status?.kind === 'PAID_LEAVE' || status?.kind === 'UNPAID_LEAVE') && status.portion === 'FIRST_HALF';
}

/**
 * Is this day outside the shift-start check? Only an ordinary working day is
 * judged at the shift start. Any leave is not: full-day leave expects nobody,
 * first-half leave is judged at the afternoon time instead (see
 * {@link isLate}), and second-half leave is not checked — the company rule
 * production has always applied.
 */
export function lateExempt(status: LateStatusFacts | null | undefined): boolean {
  if (!status) return false;
  // HOLIDAY, WEEKLY_OFF, NO_SHIFT and every kind of leave.
  return status.kind !== 'WORKING';
}

export interface LateFacts {
  /**
   * The door punch-in for that date, as an instant: its clock reading on that
   * date in the workspace timezone. Null when nobody punched in.
   */
  punchInMs: number | null;
  /** The assigned shift's start on that date, or null when none applied. */
  shiftStartMs: number | null;
  /** Company grace after the shift start. Defaults to 30 minutes. */
  graceMinutes?: number | null;
  /** What the Working Calendar says about the day, when known. */
  status?: LateStatusFacts | null;
  /**
   * On a first-half leave day, the instant after which the punch-in is late:
   * the policy's afternoon clock time on that date; no grace. Without it such
   * a day is not judged.
   */
  halfDayLateAfterMs?: number | null;
  /**
   * How the attendance rules treat this person. Absent = STANDARD. REMOTE and
   * EXEMPT people are never late: the rules only ever judged STANDARD people,
   * and every surface (the month sheet's count, the Start column) must agree.
   */
  mode?: AttendanceRuleMode | null;
}

export function isLate(facts: LateFacts): boolean {
  if (facts.punchInMs === null) return false;
  if (facts.mode && facts.mode !== 'STANDARD') return false;
  // Off for the morning, due in the afternoon: one fixed time for everyone,
  // whatever the shift.
  if (firstHalfLeave(facts.status)) {
    return facts.halfDayLateAfterMs != null && facts.punchInMs > facts.halfDayLateAfterMs;
  }
  if (facts.shiftStartMs === null || lateExempt(facts.status)) return false;
  const grace = Math.max(0, facts.graceMinutes ?? DEFAULT_LATE_GRACE_MINUTES);
  return facts.punchInMs > facts.shiftStartMs + grace * 60_000;
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
 *  - `early`        punched in before the shift start
 *  - `late`         see {@link isLate}
 *  - `on_time`      anything else with counted time, including a day with no
 *                   punch-in — without a door reading there is no arrival to
 *                   call early or late
 */
export function shiftStatusFor(input: {
  shiftStartMs: number | null;
  /** The door punch-in for the day (see {@link LateFacts.punchInMs}). */
  punchInMs: number | null;
  countedMs: number;
  graceMinutes?: number | null;
  halfDayLateAfterMs?: number | null;
  status?: (LateStatusFacts & Partial<Pick<DayStatus, 'expectedFraction'>>) | null;
  /** The person's attendance-rule mode (see {@link LateFacts.mode}). */
  mode?: AttendanceRuleMode | null;
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
  if (input.punchInMs === null) return 'on_time';
  const late = input.late ?? isLate({
    punchInMs: input.punchInMs,
    shiftStartMs: input.shiftStartMs,
    graceMinutes: input.graceMinutes,
    halfDayLateAfterMs: input.halfDayLateAfterMs,
    status: input.status,
    mode: input.mode,
  });
  if (late) return 'late';
  return input.punchInMs < input.shiftStartMs ? 'early' : 'on_time';
}
