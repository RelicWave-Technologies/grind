import { z } from 'zod';

/**
 * Leave, company holidays and paid-leave balances — wire types shared by API,
 * dashboard and agent.
 *
 * ## The unit
 *
 * Everything is measured in DAYS as a decimal in steps of 0.5. Accrual,
 * consumption, balance, adjustment and every report column speak that one unit,
 * so nothing converts and nothing can convert wrongly.
 *
 * 0.5 is exactly representable in binary floating point (it is 2^-1), as are
 * 1.5 and 2.5 — the `0.1 + 0.2` drift that makes people reach for integer
 * minor-units does not apply to halves. Decimal days add and subtract exactly.
 *
 * This also matches what the company's Lark "Leave" approval already emits:
 * a Half Day carries Duration "0.5" and a Casual Leave carries "1".
 */

/** Balance and cost amounts are always a multiple of 0.5 days. */
export const LEAVE_DAY_STEP = 0.5;

/** True when a number sits exactly on the 0.5 grid. */
function isHalfDayStep(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n / LEAVE_DAY_STEP - Math.round(n / LEAVE_DAY_STEP)) < 1e-9;
}

const HALF_STEP_MESSAGE = 'must be a multiple of 0.5 days';

/**
 * Non-negative day amount on the 0.5 grid. A factory rather than a constant
 * because `.refine()` returns a ZodEffects, which can no longer take `.max()`
 * — so the bound has to be applied to the number before the grid check.
 */
export function leaveDaysSchema(max?: number) {
  const base = max === undefined ? z.number().min(0) : z.number().min(0).max(max);
  return base.refine(isHalfDayStep, { message: HALF_STEP_MESSAGE });
}

/** Non-negative days, unbounded. */
export const LeaveDaysSchema = leaveDaysSchema();

/** Signed variant — ledger entries may be negative (consumption, reversal). */
export const SignedLeaveDaysSchema = z.number().refine(isHalfDayStep, { message: HALF_STEP_MESSAGE });

/**
 * Round a day amount onto the 0.5 grid, killing any accumulated float fuzz.
 *
 * The `+ 0` is not decoration: negating zero gives -0, so a person who has
 * taken no leave would otherwise have a balance of `-0`. It compares unequal to
 * `0` under Object.is and reads as a bug to anyone who sees it.
 */
export function roundToHalfDay(days: number): number {
  return Math.round(days / LEAVE_DAY_STEP) * LEAVE_DAY_STEP + 0;
}

/** Render a day amount the way reports and cards show it: "1", "0.5", "2.5". */
export function formatLeaveDays(days: number): string {
  const r = roundToHalfDay(days);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// ---------------------------------------------------------------------------
// Portion — which half of the day
// ---------------------------------------------------------------------------

/**
 * Which part of the working day the person is away for.
 *
 * For the BALANCE this is only worth 0.5 or 1 and the half does not matter.
 * It matters everywhere else: a FIRST_HALF absence on a 09:00-18:00 shift means
 * work is expected from ~13:30, so attendance reads "first activity 1:45 PM" as
 * on time rather than four hours late.
 *
 * Lark's leave form encodes the same thing as AM / PM on the start and end
 * time ("Aug 15 2026 PM" = second half).
 */
export const LeavePortionSchema = z.enum(['FULL', 'FIRST_HALF', 'SECOND_HALF']);
export type LeavePortion = z.infer<typeof LeavePortionSchema>;

/** Day-fraction a portion covers. FULL = 1, either half = 0.5. */
export function portionDays(portion: LeavePortion): number {
  return portion === 'FULL' ? 1 : LEAVE_DAY_STEP;
}

// ---------------------------------------------------------------------------
// Day status — what the Working Calendar answers
// ---------------------------------------------------------------------------

/**
 * Why a person was, or was not, expected to work on a given date.
 *
 * Ordered by the precedence the Working Calendar applies: an absence can only
 * land on a day that was a working day to begin with.
 */
export const WorkingDayKindSchema = z.enum([
  /** No shift assignment covers this date — we cannot say anything. */
  'NO_SHIFT',
  /** The assigned shift has this weekday off. */
  'WEEKLY_OFF',
  /** A company holiday. Paid for everyone, costs nobody any balance. */
  'HOLIDAY',
  /** Approved leave drawn against the person's paid-leave balance. */
  'PAID_LEAVE',
  /** Approved leave with no pay and no balance cost. */
  'UNPAID_LEAVE',
  /** An ordinary expected working day. */
  'WORKING',
]);
export type WorkingDayKind = z.infer<typeof WorkingDayKindSchema>;

export const DayStatusSchema = z.object({
  date: z.string(),
  kind: WorkingDayKindSchema,
  /** Which part of the day the person is away. null when they are not away. */
  portion: LeavePortionSchema.nullable(),
  /** Is the away portion paid? Holidays and paid leave are; unpaid leave is not. */
  paid: z.boolean(),
  /**
   * Balance drawn for this day, in days. Only PAID_LEAVE is ever non-zero —
   * a holiday and a weekly off both cost 0.0, which is what stops a Mon-Fri
   * request that contains a holiday charging 5 days instead of 4.
   */
  chargedDays: z.number(),
  /**
   * How much of a normal working day the person is still expected to work:
   * 1 on a working day, 0.5 on a half-day absence, 0 when fully away.
   */
  expectedFraction: z.number(),
  /**
   * How much of `chargedDays` a balance actually covered, in days.
   *
   * Absent means nobody asked — a caller that does not hand the calendar a
   * ledger gets the old answer, where approved paid leave is simply paid.
   * Present and short of `chargedDays` means the day ran past the balance:
   * 0 for a day nothing covered, 0.5 for a full day a half balance half
   * covered. Only then do paid and unpaid both describe the same day.
   */
  fundedDays: z.number().optional(),
  /** Name of the shift in force, when one is. */
  shiftName: z.string().nullable(),
  /** Human label — "Diwali", "Casual Leave". */
  label: z.string().nullable(),
});
export type DayStatus = z.infer<typeof DayStatusSchema>;

// ---------------------------------------------------------------------------
// Company holidays
// ---------------------------------------------------------------------------

export const HolidayDtoSchema = z.object({
  id: z.string(),
  date: z.string(),
  name: z.string(),
  /** Optional team scoping — null means the whole workspace. */
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  createdAt: z.string(),
});
export type HolidayDto = z.infer<typeof HolidayDtoSchema>;

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'date must be YYYY-MM-DD');

export const CreateHolidaySchema = z.object({
  date: IsoDateSchema,
  name: z.string().trim().min(1).max(120),
  teamId: z.string().nullable().optional(),
});
export type CreateHoliday = z.infer<typeof CreateHolidaySchema>;

export const PatchHolidaySchema = z
  .object({
    date: IsoDateSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    teamId: z.string().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing_to_update' });
export type PatchHoliday = z.infer<typeof PatchHolidaySchema>;

// ---------------------------------------------------------------------------
// Leave policy
// ---------------------------------------------------------------------------

/**
 * Admin-owned leave settings, one row per workspace. Kept separate from
 * WorkspacePolicy (capture / privacy) and PayrollPolicy (a derived finance
 * worksheet) for the same reason those two are separate from each other.
 */
export const LeavePolicyDtoSchema = z.object({
  /** Days granted per calendar month. */
  monthlyAccrualDays: LeaveDaysSchema,
  /** Whether an unused balance survives the year end. */
  carryForward: z.boolean(),
  /** Ceiling on the carried balance, in days. null = uncapped. */
  carryForwardCapDays: LeaveDaysSchema.nullable(),
  /** May an approved request take the balance below zero? */
  allowNegativeBalance: z.boolean(),
  /** Accrue for the joining month itself. */
  accrueOnJoinMonth: z.boolean(),
  /**
   * YYYY-MM the workspace started keeping leave in Timo. Months before it
   * accrue nothing and their ledger entries are left out of every balance.
   * null accrues from each person's joining month.
   */
  ledgerStartMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).nullable(),
  /** Extra days granted on a birthday, once a year. 0 = off. */
  birthdayLeaveDays: LeaveDaysSchema,
  updatedAt: z.string(),
});
export type LeavePolicyDto = z.infer<typeof LeavePolicyDtoSchema>;

export const LEAVE_POLICY_DEFAULTS = {
  monthlyAccrualDays: 1,
  carryForward: true,
  carryForwardCapDays: null,
  allowNegativeBalance: false,
  accrueOnJoinMonth: true,
  ledgerStartMonth: null,
  birthdayLeaveDays: 0,
} as const;

export const PatchLeavePolicySchema = z
  .object({
    monthlyAccrualDays: leaveDaysSchema(31).optional(),
    ledgerStartMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'must be YYYY-MM').nullable().optional(),
    birthdayLeaveDays: leaveDaysSchema(31).optional(),
    carryForward: z.boolean().optional(),
    carryForwardCapDays: leaveDaysSchema(365).nullable().optional(),
    allowNegativeBalance: z.boolean().optional(),
    accrueOnJoinMonth: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing_to_update' });
export type PatchLeavePolicy = z.infer<typeof PatchLeavePolicySchema>;

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * A balance is never a number we decrement — it is the sum of these entries.
 * That makes a retried approval a no-op (entries are keyed by their source),
 * makes a cancellation a visible reversal rather than a silent add-back, and
 * makes "why is my balance 1.5?" answerable by reading the statement.
 */
export const LeaveLedgerKindSchema = z.enum(['ACCRUAL', 'CONSUMPTION', 'ADJUSTMENT']);
export type LeaveLedgerKind = z.infer<typeof LeaveLedgerKindSchema>;

export const LeaveLedgerEntryDtoSchema = z.object({
  id: z.string(),
  kind: LeaveLedgerKindSchema,
  /** Signed, in days: +1 accrual, -0.5 half-day consumption, ± adjustment. */
  days: SignedLeaveDaysSchema,
  effectiveOn: z.string(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type LeaveLedgerEntryDto = z.infer<typeof LeaveLedgerEntryDtoSchema>;

export const LeaveBalanceDtoSchema = z.object({
  userId: z.string(),
  /** Balance as of the query date, in days. */
  balanceDays: z.number(),
  accruedDays: z.number(),
  consumedDays: z.number(),
  adjustedDays: z.number(),
  asOf: z.string(),
});
export type LeaveBalanceDto = z.infer<typeof LeaveBalanceDtoSchema>;

// ---------------------------------------------------------------------------
// Leave requests
// ---------------------------------------------------------------------------

export const LeaveRequestStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
export type LeaveRequestStatus = z.infer<typeof LeaveRequestStatusSchema>;

/**
 * Where the decision came from. LARK_APPROVAL is the company's existing Lark
 * approval flow; DASHBOARD is an admin deciding in Timo when Lark is not
 * wired up.
 */
export const LeaveDecisionSourceSchema = z.enum([
  'LARK_APPROVAL',
  'DASHBOARD',
  'REQUESTER_CANCEL',
]);
export type LeaveDecisionSource = z.infer<typeof LeaveDecisionSourceSchema>;

/** Paid draws down the balance; unpaid does not. */
export const LeaveKindSchema = z.enum(['PAID', 'UNPAID']);
export type LeaveKind = z.infer<typeof LeaveKindSchema>;

export const LeaveRequestDtoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string(),
  kind: LeaveKindSchema,
  startDate: z.string(),
  endDate: z.string(),
  /** Portion applies to a single-day request; multi-day requests are FULL. */
  portion: LeavePortionSchema,
  /** What this request costs the balance, priced when it was submitted. */
  chargedDays: z.number(),
  reason: z.string(),
  status: LeaveRequestStatusSchema,
  decisionSource: LeaveDecisionSourceSchema.nullable(),
  decidedAt: z.string().nullable(),
  decidedByName: z.string().nullable(),
  /** Lark approval instance backing this request, when there is one. */
  larkInstanceCode: z.string().nullable(),
  createdAt: z.string(),
});
export type LeaveRequestDto = z.infer<typeof LeaveRequestDtoSchema>;

export const CreateLeaveRequestSchema = z
  .object({
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
    portion: LeavePortionSchema.default('FULL'),
    kind: LeaveKindSchema.default('PAID'),
    reason: z.string().trim().min(1).max(1000),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'endDate must not be before startDate' })
  .refine((v) => v.portion === 'FULL' || v.startDate === v.endDate, {
    message: 'a half-day request must start and end on the same date',
  });
export type CreateLeaveRequest = z.infer<typeof CreateLeaveRequestSchema>;

export const DecideLeaveRequestSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(500).optional(),
});
export type DecideLeaveRequest = z.infer<typeof DecideLeaveRequestSchema>;

/** Quote returned before submitting, so the requester sees the real cost. */
export const LeaveQuoteSchema = z.object({
  chargedDays: z.number(),
  balanceDays: z.number(),
  balanceAfterDays: z.number(),
  sufficient: z.boolean(),
  days: z.array(DayStatusSchema),
});
export type LeaveQuote = z.infer<typeof LeaveQuoteSchema>;
