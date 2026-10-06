import {
  roundToHalfDay,
  type AttendanceRuleMode,
  type AttendanceRuleTag,
  type AttendanceRuleVerdict,
  type DayStatus,
} from '@grind/types';
import type { MonthPerformanceCode } from '../reports/monthPerformance';

/**
 * The attendance rules — whether a working day fell short, and by how much.
 *
 * Four company rules, applied to every working day from the date the leave
 * policy switches them on:
 *
 *   1. An approved half-day leave whose working half is under the half-day
 *      minimum (3 h 30 by default) is a full-day leave.
 *   2. A full working day under the full-day minimum (7 h by default) is a half day —
 *      and under the half-day minimum too, a full leave. Otherwise taking a
 *      half-day leave would cost more than taking nothing and working an hour.
 *   3. Working from home without an approved WFH request is leave.
 *   4. Absent without an approved leave application is leave without approval.
 *   5. Arriving after the shift start plus the grace period is a late arrival.
 *      A few a month are allowed; each one after that is half a day of leave —
 *      unless another rule already charged that day, which is the one cut.
 *
 * A verdict is a number of days of leave, never a new kind of day. Whether that
 * leave is paid is the balance's answer, decided by the same funding walk that
 * decides it for leave filed in Lark, so a rule cannot hand out pay a balance
 * does not hold and the paid / unpaid totals keep adding up.
 *
 * "Worked" is Timo's tracked time — work, meetings and approved manual time —
 * the same figure the report prints as Total Working Hours. A day is "worked
 * from home" when time was tracked and the punch record has no entry for it,
 * on a date the punch import covers at all: a missed import must not turn the
 * whole company into unapproved home workers.
 *
 * Pure. Everything a verdict depends on is handed in.
 */

export interface AttendanceRulePolicy {
  /** First YYYY-MM-DD judged. null = rules off. */
  from: string | null;
  fullDayMinMinutes: number;
  halfDayMinMinutes: number;
  wfhRequiresApproval: boolean;
}

export interface AttendanceDayFacts {
  /** YYYY-MM-DD. */
  date: string;
  /** Today in the workspace timezone. Today and later are not judged yet. */
  today: string;
  status: DayStatus | null;
  /** Tracked minutes for the day. */
  trackedMinutes: number;
  /** A punch in or out was recorded for this person-day. */
  punched: boolean;
  /** The punch import has rows for this date at all. */
  punchCoverage: boolean;
  /** An approved WFH request covers this date. */
  wfhApproved: boolean;
  /** A pending or rejected leave request covers this date. */
  leaveApplied: boolean;
  /** How the rules treat this person. Absent = STANDARD. */
  mode?: AttendanceRuleMode;
}

/** What one person-day comes to under the rules, or null when nothing is charged. */
export function judgeDay(
  policy: AttendanceRulePolicy,
  facts: AttendanceDayFacts,
): AttendanceRuleVerdict | null {
  if (!policy.from || facts.date < policy.from) return null;
  if (facts.mode === 'EXEMPT') return null;
  // A day still in progress cannot have fallen short of anything.
  if (facts.date >= facts.today) return null;

  const status = facts.status;
  // Holidays, weekly offs, days with no shift and full-day leave expect no
  // work, so there is nothing to fall short of.
  if (!status || (status.kind !== 'WORKING' && status.kind !== 'PAID_LEAVE' && status.kind !== 'UNPAID_LEAVE')) {
    return null;
  }
  const expected = status.expectedFraction;
  if (expected <= 0) return null;

  const minutes = Math.max(0, facts.trackedMinutes);
  const verdict = (tag: AttendanceRuleTag, penaltyDays: number): AttendanceRuleVerdict => ({
    tag,
    penaltyDays: roundToHalfDay(penaltyDays),
  });

  // The working half of an approved half-day leave.
  if (expected < 1) {
    return minutes >= policy.halfDayMinMinutes ? null : verdict('HALF_DAY_SHORT', expected);
  }

  // Nobody at the door and nothing tracked: away, and the only question is
  // whether an application exists that simply was not approved.
  if (minutes === 0 && !facts.punched) {
    return verdict(facts.leaveApplied ? 'LEAVE_NOT_APPROVED' : 'NO_APPLICATION', expected);
  }

  // Somebody remote by arrangement has no punch to miss.
  const remote = facts.mode !== 'REMOTE' && facts.punchCoverage && !facts.punched && minutes > 0;
  if (remote && policy.wfhRequiresApproval && !facts.wfhApproved) {
    return verdict('WFH_UNAPPROVED', expected);
  }

  if (minutes >= policy.fullDayMinMinutes) return null;
  if (minutes >= policy.halfDayMinMinutes) return verdict('SHORT_DAY', 0.5);
  return verdict('UNDER_MIN', 1);
}

/**
 * Was this arrival late? After the shift's start plus the grace, by the punch.
 * Measured only on an ordinary full working day by somebody who punches: a
 * half-day leave moves the start, and a remote person has no door to be late
 * through.
 */
export function isLateArrival(input: {
  status: DayStatus | null;
  mode: AttendanceRuleMode;
  punchInMinute: number | null;
  shiftStart: string | null;
  graceMinutes: number;
  /** First-half leave day: late after this minute of the day, no grace. */
  halfDayLateAfterMinute: number;
}): boolean {
  if (input.mode !== 'STANDARD') return false;
  if (input.punchInMinute === null) return false;
  // Off for the morning, due in the afternoon: one fixed time for everyone.
  // A second-half leave day is not checked.
  if (input.status?.portion === 'FIRST_HALF' && input.status.expectedFraction > 0) {
    return input.punchInMinute > input.halfDayLateAfterMinute;
  }
  if (input.status?.kind !== 'WORKING' || input.status.expectedFraction < 1) return false;
  if (!input.shiftStart) return false;
  const m = /^(\d{2}):(\d{2})$/u.exec(input.shiftStart);
  if (!m) return false;
  const start = Number.parseInt(m[1]!, 10) * 60 + Number.parseInt(m[2]!, 10);
  return input.punchInMinute > start + input.graceMinutes;
}

/**
 * The verdict for a day once late arrivals are counted. Another rule's verdict
 * stands on its own — one cut a day. Otherwise the Nth late arrival of the
 * month costs half a day once N is past the allowance.
 */
export function withLateRule(
  base: AttendanceRuleVerdict | null,
  lateOrdinal: number | null,
  allowedPerMonth: number,
): AttendanceRuleVerdict | null {
  if (base) return base;
  if (lateOrdinal !== null && lateOrdinal > allowedPerMonth) return { tag: 'LATE', penaltyDays: 0.5 };
  return null;
}

/**
 * The status code for a day a rule charged.
 *
 * The day is away for whatever leave was approved plus whatever the rule added,
 * and the balance pays for as much of the chargeable part as it reaches.
 * `fundedDays` is the calendar's answer for how much of the day's cost a
 * balance covered, undefined when it covered all of it.
 */
export function ruleCode(
  status: DayStatus,
  verdict: AttendanceRuleVerdict,
  fundedDays: number | undefined,
): MonthPerformanceCode {
  const approvedAway = roundToHalfDay(1 - status.expectedFraction);
  const away = Math.min(1, roundToHalfDay(approvedAway + verdict.penaltyDays));
  // Unpaid leave costs a balance nothing; paid leave and every rule day do.
  const cost = roundToHalfDay((status.kind === 'PAID_LEAVE' ? approvedAway : 0) + verdict.penaltyDays);
  const paid = Math.min(away, fundedDays ?? cost);

  if (away >= 1) {
    if (paid >= 1) return 'PL';
    return paid > 0 ? 'PL_HD/LWP_HD' : 'LWP';
  }
  return paid > 0 ? 'PL_HD' : 'LWP_HD';
}
