import { z } from 'zod';
import { TimeZoneSchema } from './timezone';

export const WorkspaceSettingsDto = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timezone: TimeZoneSchema,
});
export type WorkspaceSettingsDto = z.infer<typeof WorkspaceSettingsDto>;

export const PatchWorkspaceSettingsRequest = z.object({
  timezone: TimeZoneSchema,
});
export type PatchWorkspaceSettingsRequest = z.infer<typeof PatchWorkspaceSettingsRequest>;
