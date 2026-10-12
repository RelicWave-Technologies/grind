import { ATTENDANCE_RULE_DEFAULTS, type AttendanceRuleMode, type DayStatus, type ShiftStatus } from '@grind/types';

/**
 * The facts a day is judged on — late, full, half — with one definition each,
 * shared by the reports, the team rollups and the month report.
 *
 * Lateness has two readers, judged on two different clocks against the same
 * deadline: the shift assigned for that date plus the company's grace; on a
 * first-half leave day one fixed afternoon time (14:00 unless the policy names
 * its own), with no grace; never on a day nobody judged at the shift start — a
 * holiday, a weekly off, full-day leave, leave for the second half.
 *
 *  - **The attendance rules** ({@link isLate}) judge the door: the punch-in
 *    recorded for that date. Only people the rules treat as STANDARD are ever
 *    counted, and a day with no punch-in is never late. This is what costs
 *    leave, and what the month sheet's Late number counts.
 *  - **The arrival label** every report shows ({@link arrivalStatusFor}) reads
 *    Timo: when the person's first counted time (work, meeting or manual) of
 *    that day began. It never costs anything, so it can disagree with the
 *    rules — badged in at 09:20 and started Timo at 09:45 reads Late with no
 *    late counted, and the reverse.
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
 * first-half leave is judged at the afternoon time instead, and second-half
 * leave is not checked — the company rule production has always applied.
 */
export function lateExempt(status: LateStatusFacts | null | undefined): boolean {
  if (!status) return false;
  // HOLIDAY, WEEKLY_OFF, NO_SHIFT and every kind of leave.
  return status.kind !== 'WORKING';
}

/** The deadline a day's arrival is held to — the same for both clocks. */
export interface ArrivalDeadline {
  /** The assigned shift's start on that date, or null when none applied. */
  shiftStartMs: number | null;
  /** Company grace after the shift start. Defaults to 30 minutes. */
  graceMinutes?: number | null;
  /** What the Working Calendar says about the day, when known. */
  status?: LateStatusFacts | null;
  /**
   * On a first-half leave day, the instant after which the arrival is late:
   * the policy's afternoon clock time on that date; no grace. Without it such
   * a day is not judged.
   */
  halfDayLateAfterMs?: number | null;
}

/** Did an arrival at `arrivalMs` miss the day's deadline? */
function pastDeadline(arrivalMs: number, deadline: ArrivalDeadline): boolean {
  // Off for the morning, due in the afternoon: one fixed time for everyone,
  // whatever the shift.
  if (firstHalfLeave(deadline.status)) {
    return deadline.halfDayLateAfterMs != null && arrivalMs > deadline.halfDayLateAfterMs;
  }
  if (deadline.shiftStartMs === null || lateExempt(deadline.status)) return false;
  const grace = Math.max(0, deadline.graceMinutes ?? DEFAULT_LATE_GRACE_MINUTES);
  return arrivalMs > deadline.shiftStartMs + grace * 60_000;
}

export interface LateFacts extends ArrivalDeadline {
  /**
   * The door punch-in for that date, as an instant: its clock reading on that
   * date in the workspace timezone. Null when nobody punched in.
   */
  punchInMs: number | null;
  /**
   * How the attendance rules treat this person. Absent = STANDARD. REMOTE and
   * EXEMPT people are never counted late: the rules only ever judge STANDARD
   * people (a REMOTE person has no door to punch).
   */
  mode?: AttendanceRuleMode | null;
}

/**
 * The attendance rules' late arrival: the door punch-in past the day's
 * deadline, for a STANDARD person. What the late-arrival rule counts and,
 * past the month's allowance, charges. Reports do not label days with it —
 * see {@link arrivalStatusFor}.
 */
export function isLate(facts: LateFacts): boolean {
  if (facts.punchInMs === null) return false;
  if (facts.mode && facts.mode !== 'STANDARD') return false;
  return pastDeadline(facts.punchInMs, facts);
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
 * The arrival label a report prints for a day, read from Timo.
 *
 *  - `no_shift`     no shift applied, or the day was off for the whole day
 *  - `no_activity`  a day somebody was expected and nothing was counted
 *  - `late`         Timo started past the day's deadline (the shift start plus
 *                   the grace; on a first-half leave day the afternoon time,
 *                   no grace). Never for an EXEMPT person.
 *  - `early`        Timo started before the shift start
 *  - `on_time`      anything else with counted time, including a day whose
 *                   only counted time carried on from the night before — no
 *                   start that day to call early or late
 *
 * Display only. The door punch-in and the rules' late count ({@link isLate})
 * play no part: a day can read Late here and cost nothing, or read On time
 * and still be a counted late arrival.
 */
export function arrivalStatusFor(input: ArrivalDeadline & {
  /**
   * When the day's first counted time (work, meeting or manual) began — the
   * day bucket's `first`. Null when no counted stretch started that day.
   */
  startMs: number | null;
  /** The day's counted time: work + meeting + manual. */
  countedMs: number;
  status?: (LateStatusFacts & Partial<Pick<DayStatus, 'expectedFraction'>>) | null;
  /**
   * The person's attendance-rule mode. EXEMPT people sit outside attendance
   * entirely and never read Late; STANDARD and REMOTE people are labelled from
   * when they started — a remote person who starts late did start late.
   */
  mode?: AttendanceRuleMode | null;
}): ShiftStatus {
  if (input.shiftStartMs === null) return 'no_shift';
  const offAllDay = input.status
    ? input.status.kind === 'HOLIDAY'
      || input.status.kind === 'WEEKLY_OFF'
      || input.status.kind === 'NO_SHIFT'
      || input.status.expectedFraction === 0
    : false;
  if (input.countedMs <= 0) return offAllDay ? 'no_shift' : 'no_activity';
  if (input.startMs === null) return 'on_time';
  if (input.mode !== 'EXEMPT' && pastDeadline(input.startMs, input)) return 'late';
  return input.startMs < input.shiftStartMs ? 'early' : 'on_time';
}
