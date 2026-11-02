import { z } from 'zod';
import { Role } from './auth';
import { ShiftDtoSchema } from './shifts';
import { leaveDaysSchema } from './leave';

export const SCREENSHOT_INTERVAL_OPTIONS = [1, 2, 3] as const;
export type ScreenshotIntervalMin = (typeof SCREENSHOT_INTERVAL_OPTIONS)[number];
export const DEFAULT_SCREENSHOT_INTERVAL_MIN: ScreenshotIntervalMin = 3;
export const IDLE_THRESHOLD_MIN = 1;
export const IDLE_THRESHOLD_MAX = 120;
/** The idle-threshold minutes the dashboard offers, workspace default and per member. */
export const IDLE_THRESHOLD_OPTIONS = [1, 3, 5, 10, 15, 30, 45, 60, 120] as const;

export function isScreenshotIntervalMin(value: unknown): value is ScreenshotIntervalMin {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    (SCREENSHOT_INTERVAL_OPTIONS as readonly number[]).includes(value);
}

export function normalizeScreenshotIntervalMin(
  value: number | null | undefined,
  fallback: number = DEFAULT_SCREENSHOT_INTERVAL_MIN,
): ScreenshotIntervalMin {
  if (isScreenshotIntervalMin(value)) return value;
  return isScreenshotIntervalMin(fallback) ? fallback : DEFAULT_SCREENSHOT_INTERVAL_MIN;
}

export const ScreenshotIntervalMinSchema = z
  .number()
  .int()
  .refine(isScreenshotIntervalMin, { message: 'invalid_screenshot_interval' });

export const TeamSettingsPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().nullable().default(null),
});

export const TeamSettingsTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const TeamMemberSettingsDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().nullable().default(null),
  role: Role,
  team: TeamSettingsTeamSchema.nullable(),
  manager: TeamSettingsPersonSchema.nullable(),
  shiftId: z.string().nullable(),
  shiftAssignedAt: z.string().datetime({ offset: true }).nullable(),
  screenshotIntervalMin: ScreenshotIntervalMinSchema,
  idleThresholdMin: z.number().int().min(IDLE_THRESHOLD_MIN).max(IDLE_THRESHOLD_MAX),
  idleWarningSeconds: z.number().int().min(5).max(120).nullable(),
  /** How the attendance rules treat them: office, remote (no punch), or outside the rules. */
  attendanceRuleMode: z.enum(['STANDARD', 'REMOTE', 'EXEMPT']).default('STANDARD'),
  /** The employer they work for (EMIAC / MACOBS); null when unset. */
  unit: TeamSettingsTeamSchema.nullable().default(null),
  /** Paid leave earned each month: their own rate, or null to follow the leave policy. */
  leaveAccrualDays: z.number().nullable().default(null),
  /** The rate that applies — their own, else the leave policy's. */
  effectiveLeaveAccrualDays: z.number().default(1),
  createdAt: z.string().datetime({ offset: true }),
});

export type TeamMemberSettingsDto = z.infer<typeof TeamMemberSettingsDtoSchema>;

export const TeamSettingsResponseSchema = z.object({
  scope: z.enum(['team', 'workspace']),
  members: z.array(TeamMemberSettingsDtoSchema),
  shifts: z.array(ShiftDtoSchema),
  /** The workspace's units, for the admin's unit picker. */
  units: z.array(TeamSettingsTeamSchema).default([]),
});

export type TeamSettingsResponse = z.infer<typeof TeamSettingsResponseSchema>;

export const PatchTeamMemberSettingsRequest = z
  .object({
    shiftId: z.string().nullable().optional(),
    // null clears the per-member override → the member inherits the workspace
    // policy default. A number sets an explicit per-member override.
    screenshotIntervalMin: ScreenshotIntervalMinSchema.nullable().optional(),
    idleThresholdMin: z.number().int().min(IDLE_THRESHOLD_MIN).max(IDLE_THRESHOLD_MAX).nullable().optional(),
    idleWarningSeconds: z.number().int().min(5).max(120).nullable().optional(),
    attendanceRuleMode: z.enum(['STANDARD', 'REMOTE', 'EXEMPT']).optional(),
    // Admin only. null clears the unit.
    unitId: z.string().nullable().optional(),
    // Admin only. null follows the workspace leave policy's monthly rate.
    leaveAccrualDays: leaveDaysSchema(31).nullable().optional(),
    auditReason: z.string().max(500).optional(),
  })
  .refine(
    (v) =>
      v.shiftId !== undefined ||
      v.screenshotIntervalMin !== undefined ||
      v.idleThresholdMin !== undefined ||
      v.idleWarningSeconds !== undefined ||
      v.attendanceRuleMode !== undefined ||
      v.unitId !== undefined ||
      v.leaveAccrualDays !== undefined,
    { message: 'nothing_to_update' },
  );

export type PatchTeamMemberSettingsRequest = z.infer<typeof PatchTeamMemberSettingsRequest>;
