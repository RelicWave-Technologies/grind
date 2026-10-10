import { z } from 'zod';
import { Role } from './auth';
import { ShiftDtoSchema } from './shifts';
import { WorkspacePolicyDto } from './workspacePolicy';
import { TimeZoneSchema } from './timezone';

export const ProfilePersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().nullable().default(null),
});

export const ProfileTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberCount: z.number().int().min(0),
});

export const ProfileWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  timezone: TimeZoneSchema,
  createdAt: z.string().datetime({ offset: true }),
});

export const SelfProfileUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().nullable().default(null),
  role: Role,
  displayRole: Role,
  createdAt: z.string().datetime({ offset: true }),
});

export const SelfProfileShiftSchema = ShiftDtoSchema.extend({
  assignedAt: z.string().datetime({ offset: true }).nullable(),
}).nullable();

export const SelfProfilePolicySchema = WorkspacePolicyDto.pick({
  captureApps: true,
  captureTitles: true,
  captureUrls: true,
  retentionDaysScreenshots: true,
});

export const SelfProfileResponseSchema = z.object({
  user: SelfProfileUserSchema,
  workspace: ProfileWorkspaceSchema,
  team: ProfileTeamSchema.nullable(),
  manager: ProfilePersonSchema.nullable(),
  shift: SelfProfileShiftSchema,
  policy: SelfProfilePolicySchema,
});

export type SelfProfileResponse = z.infer<typeof SelfProfileResponseSchema>;
