import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });

/**
 * The agent submits a manual-time request after the fact, attributable to a
 * Lark task (or untagged). The server picks an approver (workspace admin for
 * now; manager-scoped when Team lands with M11) and sends an interactive card.
 */
export const CreateManualTimeRequest = z.object({
  clientUuid: z.string().min(1),
  larkTaskGuid: z.string().min(1).nullable().optional(),
  /** Optional task summary the agent already has, used to populate the card. */
  taskSummary: z.string().max(256).nullable().optional(),
  requestedStart: Iso,
  requestedEnd: Iso,
  reason: z.string().min(1).max(1000),
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
  })
  .refine(
    (v) =>
      v.requestedStart !== undefined ||
      v.requestedEnd !== undefined ||
      v.larkTaskGuid !== undefined ||
      v.taskSummary !== undefined ||
      v.reason !== undefined,
    { message: 'at least one field must be set' },
  );
export type PatchManualTimeRequest = z.infer<typeof PatchManualTimeRequest>;

export const ManualTimeRequestDto = z.object({
  id: z.string(),
  clientUuid: z.string(),
  userId: z.string(),
  approverId: z.string().nullable(),
  larkTaskGuid: z.string().nullable(),
  larkMessageId: z.string().nullable(),
  requestedStart: Iso,
  requestedEnd: Iso,
  reason: z.string(),
  status: ManualTimeRequestStatus,
  decidedAt: Iso.nullable(),
  decidedReason: z.string().nullable(),
  createdAt: Iso,
});
export type ManualTimeRequestDto = z.infer<typeof ManualTimeRequestDto>;

export const ListManualTimeRequestsQuery = z.object({
  /** "mine" (default): requests I submitted. "approvals": where I'm the approver. */
  role: z.enum(['mine', 'approvals']).default('mine'),
  status: ManualTimeRequestStatus.optional(),
});
export type ListManualTimeRequestsQuery = z.infer<typeof ListManualTimeRequestsQuery>;
