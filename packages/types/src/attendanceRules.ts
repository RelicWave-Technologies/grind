import { z } from 'zod';

/**
 * Attendance rules — the company's minimum-hours and approval rules, applied to
 * every working day from the date the leave policy switches them on.
 *
 * A rule never invents a new kind of day. What it does is decide that part or
 * all of a working day was really leave, and that leave is then paid or unpaid
 * exactly the way leave filed in Lark is: drawn from the balance as far as the
 * balance reaches, Leave Without Pay past it. So the status code keeps saying
 * paid or unpaid, and the rule tag says *why* the day was leave at all.
 */

/**
 * Why a rule charged a day.
 *
 *   SHORT_DAY           a full working day short of the full-day minimum
 *   UNDER_MIN           a full working day short of the half-day minimum too
 *   HALF_DAY_SHORT      an approved half-day leave whose working half fell short
 *   WFH_UNAPPROVED      worked away from the office with no approved WFH request
 *   NO_APPLICATION      nothing worked, nothing applied for
 *   LEAVE_NOT_APPROVED  nothing worked; leave was applied for but is pending or rejected
 *   LATE                arrived after the shift start plus its grace, past the month's allowance
 */
export const AttendanceRuleTagSchema = z.enum([
  'SHORT_DAY',
  'UNDER_MIN',
  'HALF_DAY_SHORT',
  'WFH_UNAPPROVED',
  'NO_APPLICATION',
  'LEAVE_NOT_APPROVED',
  'LATE',
]);
export type AttendanceRuleTag = z.infer<typeof AttendanceRuleTagSchema>;

/**
 * Short spellings for a grid cell, which is a dozen characters wide.
 * `LWA` — Leave Without Approval — is what the company already calls it.
 */
export const ATTENDANCE_RULE_SHORT: Record<AttendanceRuleTag, string> = {
  SHORT_DAY: 'SHORT',
  UNDER_MIN: 'UNDER HALF',
  HALF_DAY_SHORT: 'HD SHORT',
  WFH_UNAPPROVED: 'WFH NA',
  NO_APPLICATION: 'LWA',
  LEAVE_NOT_APPROVED: 'LWA PENDING',
  LATE: 'LATE',
};

/** Spelled out, for a legend or a tooltip. */
export const ATTENDANCE_RULE_LABEL: Record<AttendanceRuleTag, string> = {
  SHORT_DAY: 'Worked less than a full day — counted as a half day',
  UNDER_MIN: 'Worked less than half a day — counted as a full leave',
  HALF_DAY_SHORT: 'Half-day leave, but the working half fell short — counted as a full leave',
  WFH_UNAPPROVED: 'Worked from home without an approved WFH request — counted as leave',
  NO_APPLICATION: 'Absent without a leave application — leave without approval',
  LEAVE_NOT_APPROVED: 'Absent; the leave applied for was not approved — leave without approval',
  LATE: 'Late arrival past the monthly allowance — half a day of leave',
};

/**
 * How the rules treat one person.
 *
 *   STANDARD  every rule
 *   REMOTE    works away from the office by arrangement: no punch is expected,
 *             so the work-from-home rule is skipped; hours and absence still count
 *   EXEMPT    outside the rules entirely
 */
export const AttendanceRuleModeSchema = z.enum(['STANDARD', 'REMOTE', 'EXEMPT']);
export type AttendanceRuleMode = z.infer<typeof AttendanceRuleModeSchema>;

/** What a rule decided about one person-day. */
export const AttendanceRuleVerdictSchema = z.object({
  tag: AttendanceRuleTagSchema,
  /** Days of the day the rule turned into leave: 0.5 or 1. */
  penaltyDays: z.number(),
});
export type AttendanceRuleVerdict = z.infer<typeof AttendanceRuleVerdictSchema>;

export const ATTENDANCE_RULE_DEFAULTS = {
  attendanceRulesFrom: null,
  /** 7 h. */
  fullDayMinMinutes: 420,
  /** 3 h 30 m. */
  halfDayMinMinutes: 210,
  wfhRequiresApproval: true,
  /** Late arrivals a month that cost nothing; each one after is half a day. */
  lateAllowedPerMonth: 4,
  /** Minutes after the shift start that still count as on time. */
  lateGraceMinutes: 30,
} as const;

/** One charged day, as the exceptions list shows it. */
export const AttendanceRuleExceptionSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  teamName: z.string().nullable(),
  /** YYYY-MM-DD. */
  date: z.string(),
  tag: AttendanceRuleTagSchema,
  penaltyDays: z.number(),
  /** Tracked minutes that day. */
  workMinutes: z.number(),
  /** Whether a punch was recorded — the office/home signal. */
  punched: z.boolean(),
  /** The status code the report prints for the day. */
  code: z.string(),
});
export type AttendanceRuleException = z.infer<typeof AttendanceRuleExceptionSchema>;

export const AttendanceRuleExceptionsResponseSchema = z.object({
  month: z.string(),
  /** null when the rules are off. */
  rulesFrom: z.string().nullable(),
  exceptions: z.array(AttendanceRuleExceptionSchema),
});
export type AttendanceRuleExceptionsResponse = z.infer<typeof AttendanceRuleExceptionsResponseSchema>;
