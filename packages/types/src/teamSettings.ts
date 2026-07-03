import { z } from 'zod';
import { Role } from './auth';
import { ShiftDtoSchema } from './shifts';

export const MEMBER_SETTING_DEFAULTS = {
  screenshotIntervalMin: 180,
  idleThresholdMin: 5,
} as const;

export const SCREENSHOT_INTERVAL_MIN = 1;
export const SCREENSHOT_INTERVAL_MAX = 480;
export const IDLE_THRESHOLD_MIN = 1;
export const IDLE_THRESHOLD_MAX = 120;

export const TeamSettingsPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().nullable().default(null),
});

export type TeamSettingsPerson = z.infer<typeof TeamSettingsPersonSchema>;

export const TeamSettingsTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type TeamSettingsTeam = z.infer<typeof TeamSettingsTeamSchema>;

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
  screenshotIntervalMin: z.number().int().min(SCREENSHOT_INTERVAL_MIN).max(SCREENSHOT_INTERVAL_MAX),
  idleThresholdMin: z.number().int().min(IDLE_THRESHOLD_MIN).max(IDLE_THRESHOLD_MAX),
  createdAt: z.string().datetime({ offset: true }),
});

export type TeamMemberSettingsDto = z.infer<typeof TeamMemberSettingsDtoSchema>;

export const TeamSettingsResponseSchema = z.object({
  scope: z.enum(['team', 'workspace']),
  members: z.array(TeamMemberSettingsDtoSchema),
  shifts: z.array(ShiftDtoSchema),
});

export type TeamSettingsResponse = z.infer<typeof TeamSettingsResponseSchema>;

export const PatchTeamMemberSettingsRequest = z
  .object({
    shiftId: z.string().nullable().optional(),
    // null clears the per-member override → the member inherits the workspace
    // policy default. A number sets an explicit per-member override.
    screenshotIntervalMin: z.number().int().min(SCREENSHOT_INTERVAL_MIN).max(SCREENSHOT_INTERVAL_MAX).nullable().optional(),
    idleThresholdMin: z.number().int().min(IDLE_THRESHOLD_MIN).max(IDLE_THRESHOLD_MAX).nullable().optional(),
    auditReason: z.string().max(500).optional(),
  })
  .refine(
    (v) =>
      v.shiftId !== undefined ||
      v.screenshotIntervalMin !== undefined ||
      v.idleThresholdMin !== undefined,
    { message: 'nothing_to_update' },
  );

export type PatchTeamMemberSettingsRequest = z.infer<typeof PatchTeamMemberSettingsRequest>;
