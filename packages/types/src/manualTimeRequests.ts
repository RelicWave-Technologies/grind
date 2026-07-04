import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });

/**
 * A user submits manual time after the fact, attributable to a Lark task (or
 * untagged). Members enter the approval flow; managers/admins can create
 * approved supervisor/self edits.
 */
export const CreateManualTimeRequest = z.object({
  clientUuid: z.string().min(1),
  /** Optional target user for manager/admin scoped edits. Omitted = caller. */
  userId: z.string().min(1).optional(),
  larkTaskGuid: z.string().min(1).nullable().optional(),
  /** Optional task summary the agent already has, used to populate the card. */
  taskSummary: z.string().max(256).nullable().optional(),
  requestedStart: Iso,
  requestedEnd: Iso,
  reason: z.string().min(1).max(1000),
  /** Workspace user-ids who were in this meeting (optional). Validated
   *  server-side: all must be in the requester's workspace and exclude
   *  the requester themselves (they're implicit). Capped at 50 to bound
   *  payload size. */
  attendeeIds: z.array(z.string().min(1)).max(50).optional(),
});
export type CreateManualTimeRequest = z.infer<typeof CreateManualTimeRequest>;

export const ManualTimeRequestStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
export type ManualTimeRequestStatus = z.infer<typeof ManualTimeRequestStatus>;

/**
 * Patch a still-PENDING request (the requester's only escape hatch besides
 * "Cancel" before the approver clicks). Server returns 409 if status !=
 * PENDING since edits are immutable after a decision.
 */
export const PatchManualTimeRequest = z
  .object({
    requestedStart: Iso.optional(),
    requestedEnd: Iso.optional(),
    larkTaskGuid: z.string().min(1).nullable().optional(),
    taskSummary: z.string().max(256).nullable().optional(),
    reason: z.string().min(1).max(1000).optional(),
    attendeeIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .refine(
    (v) =>
      v.requestedStart !== undefined ||
      v.requestedEnd !== undefined ||
      v.larkTaskGuid !== undefined ||
      v.taskSummary !== undefined ||
      v.reason !== undefined ||
      v.attendeeIds !== undefined,
    { message: 'at least one field must be set' },
  );
export type PatchManualTimeRequest = z.infer<typeof PatchManualTimeRequest>;

export const ManualTimeRequestDto = z.object({
  id: z.string(),
  clientUuid: z.string(),
  userId: z.string(),
  approverId: z.string().nullable(),
  larkTaskGuid: z.string().nullable(),
  taskSummary: z.string().nullable().optional(),
  larkMessageId: z.string().nullable(),
  requestedStart: Iso,
  requestedEnd: Iso,
  reason: z.string(),
  status: ManualTimeRequestStatus,
  autoApproved: z.boolean().optional(),
  decidedAt: Iso.nullable(),
  decidedReason: z.string().nullable(),
  createdAt: Iso,
  attendeeIds: z.array(z.string()).optional(),
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), avatarUrl: z.string().nullable().default(null) }).optional(),
  approver: z.object({ id: z.string(), name: z.string(), email: z.string(), avatarUrl: z.string().nullable().default(null) }).nullable().optional(),
});
export type ManualTimeRequestDto = z.infer<typeof ManualTimeRequestDto>;

export const ListManualTimeRequestsQuery = z.object({
  /** "mine" (default): requests I submitted. "approvals": where I'm the approver. */
  role: z.enum(['mine', 'approvals']).default('mine'),
  status: ManualTimeRequestStatus.optional(),
  /** Optional local-day range. When omitted, the legacy latest-200 list is returned. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  tz: z.string().min(1).max(100).optional(),
});
export type ListManualTimeRequestsQuery = z.infer<typeof ListManualTimeRequestsQuery>;
