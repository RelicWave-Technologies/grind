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
 *   LATE                punched in after the shift start plus its grace, past the month's allowance
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

/** A few words each, for a list where the full sentence would wrap. */
export const ATTENDANCE_RULE_REASON: Record<AttendanceRuleTag, string> = {
  SHORT_DAY: 'Short day',
  UNDER_MIN: 'Under half a day',
  HALF_DAY_SHORT: 'Half-day leave, short hours',
  WFH_UNAPPROVED: 'WFH not approved',
  NO_APPLICATION: 'Absent, no leave applied',
  LEAVE_NOT_APPROVED: 'Absent, leave not approved',
  LATE: 'Late arrival',
};

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
  /** On a first-half leave day, a punch-in after 14:00 is late — no grace. */
  halfDayLateAfterMinute: 840,
} as const;

/**
 * One person's month on one row — the same counts as the exported sheet, the
 * salary cut, and the leave account with every change behind it.
 */
export const MonthSummaryRowSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  teamName: z.string().nullable(),
  mode: z.enum(['STANDARD', 'REMOTE', 'EXEMPT']),
  present: z.number(),
  halfDay: z.number(),
  /** Full days of leave the balance paid for. */
  pl: z.number(),
  leave: z.number(),
  lwa: z.number(),
  late: z.number(),
  salaryCut: z.number(),
  /** Days of the month salary is paid for: days in the month − salary cut. */
  payableDays: z.number(),
  account: z.object({
    opening: z.number(),
    earned: z.number(),
    /** `earned`, split by where it came from. */
    earnedMonthly: z.number(),
    earnedBirthday: z.number(),
    earnedOther: z.number(),
    paid: z.number(),
    closing: z.number(),
    lines: z.array(
      z.object({
        date: z.string(),
        kind: z.enum(['credit', 'leave']),
        label: z.string(),
        days: z.number(),
        paid: z.number().optional(),
        salaryCut: z.number().optional(),
        /** The day's code on the sheet, for a leave line. */
        code: z.string().optional(),
      }),
    ),
  }),
});
export type MonthSummaryRow = z.infer<typeof MonthSummaryRowSchema>;

export const MonthSummaryResponseSchema = z.object({
  month: z.string(),
  rulesFrom: z.string().nullable(),
  rows: z.array(MonthSummaryRowSchema),
});
export type MonthSummaryResponse = z.infer<typeof MonthSummaryResponseSchema>;

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

/**
 * What a day reads as to a person — six words HR already uses. The month sheet
 * and the dashboard chips print these; the detailed codes underneath
 * (`PL_HD/LWP_HD` and the rest) stay internal, because whether a half was
 * paid is one Salary Cut figure, not something to decode in every cell.
 *
 *   P    present, a full day
 *   HD   half day — worked half, the other half was leave
 *   PL   paid leave — a full day of leave the balance paid for
 *   L    leave the balance did not (fully) pay for — approved, or made leave by a rule
 *   LWA  leave without approval — absent with no approved application
 *   HL   company holiday
 *   WO   weekly off
 *   --   no shift assigned
 */
export type DisplayDayCode = 'P' | 'HD' | 'PL' | 'L' | 'LWA' | 'HL' | 'WO' | '--';

export function displayDayCode(code: string, ruleTag?: AttendanceRuleTag | null): DisplayDayCode {
  switch (code) {
    case 'P': return 'P';
    case 'PL_HD':
    case 'LWP_HD': return 'HD';
    case 'HL': return 'HL';
    case 'WO': return 'WO';
    case '--': return '--';
    // Absent with nothing approved is exactly what LWA means.
    case 'A': return 'LWA';
  }
  if (ruleTag === 'NO_APPLICATION' || ruleTag === 'LEAVE_NOT_APPROVED') return 'LWA';
  // A full day the balance paid for in full; anything short of that is L.
  return code === 'PL' ? 'PL' : 'L';
}

export const DISPLAY_DAY_LABEL: Record<DisplayDayCode, string> = {
  P: 'Present',
  HD: 'Half day',
  PL: 'Paid leave',
  L: 'Leave — not covered by the balance',
  LWA: 'Leave without approval',
  HL: 'Holiday',
  WO: 'Weekly off',
  '--': 'No shift',
};
