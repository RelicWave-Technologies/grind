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

/** An admin who can receive the "new person wants access" Lark card. */
export const AccessRequestRecipientDto = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string(),
  /** Without a Lark identity the card cannot reach them. */
  hasLark: z.boolean(),
  chosen: z.boolean(),
});
export type AccessRequestRecipientDto = z.infer<typeof AccessRequestRecipientDto>;

export const AccessRequestRecipientsResponse = z.object({
  /** Empty choice = every admin gets the card. */
  allAdmins: z.boolean(),
  admins: z.array(AccessRequestRecipientDto),
});
export type AccessRequestRecipientsResponse = z.infer<typeof AccessRequestRecipientsResponse>;

export const PutAccessRequestRecipientsRequest = z.object({
  /** Admin ids; [] = every admin. */
  userIds: z.array(z.string().min(1)).max(200),
});
export type PutAccessRequestRecipientsRequest = z.infer<typeof PutAccessRequestRecipientsRequest>;
