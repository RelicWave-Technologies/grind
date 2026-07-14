import { z } from 'zod';
import { HHMMSchema } from './shifts';
import { TimeZoneSchema } from './timezone';

const PayrollMinuteSchema = z.number().int().min(1).max(24 * 60);
const PayrollMonthlyMinuteSchema = z.number().int().min(1).max(31 * 24 * 60);
const MonthCloseDaySchema = z.number().int().min(1).max(28);

export const PayrollRecipientModeSchema = z.enum(['all_admins']);
export type PayrollRecipientMode = z.infer<typeof PayrollRecipientModeSchema>;

export const PAYROLL_POLICY_DEFAULTS = {
  halfDayLowerMin: 240,
  halfDayUpperMin: 480,
  fullDayLowerMin: 480,
  fullDayUpperMin: 600,
  monthlyLowerMin: 9600,
  timezone: 'UTC',
  approvalReminderDays: [3, 4],
  approvalReminderTime: '00:00',
  payrollSheetSendDay: 5,
  payrollSheetSendTime: '00:00',
  sendPayrollSheetTo: 'all_admins',
} as const;

const PayrollPolicyFieldsSchema = z.object({
    halfDayLowerMin: PayrollMinuteSchema,
    halfDayUpperMin: PayrollMinuteSchema,
    fullDayLowerMin: PayrollMinuteSchema,
    fullDayUpperMin: PayrollMinuteSchema,
    monthlyLowerMin: PayrollMonthlyMinuteSchema,
    timezone: TimeZoneSchema,
    approvalReminderDays: z.array(MonthCloseDaySchema).min(1).max(4),
    approvalReminderTime: HHMMSchema,
    payrollSheetSendDay: MonthCloseDaySchema,
    payrollSheetSendTime: HHMMSchema,
    sendPayrollSheetTo: PayrollRecipientModeSchema,
  });

function refinePayrollPolicy(v: z.infer<typeof PayrollPolicyFieldsSchema>, ctx: z.RefinementCtx) {
    const uniqueDays = new Set(v.approvalReminderDays);
    if (uniqueDays.size !== v.approvalReminderDays.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'approval_days_must_be_unique', path: ['approvalReminderDays'] });
    }
    if (v.halfDayLowerMin > v.halfDayUpperMin) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'half_day_lower_must_be_lte_upper', path: ['halfDayLowerMin'] });
    }
    if (v.halfDayUpperMin !== v.fullDayLowerMin) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'half_day_upper_must_equal_full_day_lower', path: ['halfDayUpperMin'] });
    }
    if (v.fullDayLowerMin > v.fullDayUpperMin) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'full_day_lower_must_be_lte_upper', path: ['fullDayLowerMin'] });
    }
}

export const PayrollPolicySettingsSchema = PayrollPolicyFieldsSchema.superRefine(refinePayrollPolicy);
export type PayrollPolicySettings = z.infer<typeof PayrollPolicySettingsSchema>;

export const PayrollPolicyDto = PayrollPolicyFieldsSchema.extend({
    workspaceId: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .superRefine(refinePayrollPolicy);
export type PayrollPolicyDto = z.infer<typeof PayrollPolicyDto>;

export const PatchPayrollPolicyRequest = PayrollPolicyFieldsSchema.partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at_least_one_field_required' })
  .superRefine((patch, ctx) => {
    // Cross-field invariants are re-checked server-side after merging with the
    // existing policy. This keeps partial PATCH ergonomic while still blocking
    // invalid final policies.
    if (
      patch.halfDayUpperMin !== undefined &&
      patch.fullDayLowerMin !== undefined &&
      patch.halfDayUpperMin !== patch.fullDayLowerMin
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'half_day_upper_must_equal_full_day_lower', path: ['halfDayUpperMin'] });
    }
  });
export type PatchPayrollPolicyRequest = z.infer<typeof PatchPayrollPolicyRequest>;

export const PayrollRunLogDto = z.object({
  id: z.string(),
  month: z.string(),
  runType: z.enum(['APPROVAL_REMINDER', 'PAYROLL_SHEET']),
  scheduledFor: z.string().datetime({ offset: true }),
  status: z.enum(['SENT', 'PARTIAL', 'FAILED', 'SKIPPED']),
  sentCount: z.number().int().min(0),
  skippedNoLarkCount: z.number().int().min(0),
  skippedUnassignedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  errors: z.unknown().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type PayrollRunLogDto = z.infer<typeof PayrollRunLogDto>;
