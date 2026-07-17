import { z } from 'zod';

export const SegmentKind = z.enum(['WORK', 'MEETING', 'IDLE_TRIMMED']);
export type SegmentKind = z.infer<typeof SegmentKind>;

export const TimeEntrySource = z.enum(['AUTO', 'MANUAL']);
export type TimeEntrySource = z.infer<typeof TimeEntrySource>;

export const AgentTimeEntryCloseReason = z.enum(['AGENT', 'AGENT_RECOVERY']);
export type AgentTimeEntryCloseReason = z.infer<typeof AgentTimeEntryCloseReason>;

/** ISO-8601 timestamp string at the wire boundary. */
const Iso = z.string().datetime({ offset: true });

export const SegmentDto = z.object({
  id: z.string().min(1),
  kind: SegmentKind,
  startedAt: Iso,
  endedAt: Iso.nullable(),
});
export type SegmentDto = z.infer<typeof SegmentDto>;

/**
 * Create a time entry. The agent generates ULIDs client-side and includes the
 * initial open segment, so the whole thing is idempotent on `clientUuid`.
 */
export const CreateTimeEntryRequest = z.object({
  id: z.string().min(1),
  clientUuid: z.string().min(1),
  larkTaskGuid: z.string().min(1).nullable().optional(),
  source: TimeEntrySource.default('AUTO'),
  trackingProtocolVersion: z.literal(2).optional(),
  revision: z.number().int().min(1).optional(),
  observedAt: Iso.optional(),
  startedAt: Iso,
  endedAt: Iso.nullable().optional(),
  agentVersion: z.string().max(50).optional(),
  platform: z.enum(['darwin', 'win32', 'linux']).optional(),
  closeReason: AgentTimeEntryCloseReason.nullable().optional(),
  segments: z.array(SegmentDto).min(1),
});
export type CreateTimeEntryRequest = z.infer<typeof CreateTimeEntryRequest>;

export const TimeEntryDto = z.object({
  id: z.string(),
  clientUuid: z.string(),
  userId: z.string(),
  larkTaskGuid: z.string().nullable(),
  source: TimeEntrySource,
  trackingProtocolVersion: z.number().int().nullable(),
  revision: z.number().int().min(0).nullable(),
  lastProvenAt: Iso.nullable(),
  leaseExpiresAt: Iso.nullable(),
  closeReason: z.enum(['AGENT', 'AGENT_RECOVERY', 'LEASE_EXPIRED', 'SUPERSEDED', 'LEGACY_RECONCILED']).nullable(),
  serverFinalizedAt: Iso.nullable(),
  startedAt: Iso,
  endedAt: Iso.nullable(),
  notes: z.string().nullable(),
  segments: z.array(SegmentDto),
});
export type TimeEntryDto = z.infer<typeof TimeEntryDto>;

/**
 * Patch the metadata on a tracked entry. Cannot change start/end/segments —
 * those are the OS-tracked truth. Used by the Edit Time table to re-attribute
 * a session to a different Lark task or add a note ("emails", "design review").
 */
export const PatchTimeEntryRequest = z
  .object({
    larkTaskGuid: z.string().min(1).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    /** Meeting attendees — only valid for entries that include at least
     *  one MEETING segment. Server returns 400 otherwise. */
    attendeeIds: z.array(z.string().min(1)).max(50).optional(),
  })
  .refine(
    (v) =>
      v.larkTaskGuid !== undefined ||
      v.notes !== undefined ||
      v.attendeeIds !== undefined,
    { message: 'at least one of larkTaskGuid, notes, or attendeeIds must be set' },
  );
export type PatchTimeEntryRequest = z.infer<typeof PatchTimeEntryRequest>;

/**
 * Sync the full segment list for an entry (agent is the source of truth for an
 * open entry). Server replaces segments + optionally closes the entry. This is
 * the idempotent "push my current state" call.
 */
export const SyncTimeEntryRequest = z.object({
  trackingProtocolVersion: z.literal(2).optional(),
  revision: z.number().int().min(1).optional(),
  observedAt: Iso.optional(),
  endedAt: Iso.nullable().optional(),
  closeReason: AgentTimeEntryCloseReason.nullable().optional(),
  segments: z.array(SegmentDto).min(1),
});
export type SyncTimeEntryRequest = z.infer<typeof SyncTimeEntryRequest>;

export const ListTimeEntriesQuery = z.object({
  from: Iso.optional(),
  to: Iso.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListTimeEntriesQuery = z.infer<typeof ListTimeEntriesQuery>;

export const ListTimeEntriesResponse = z.object({
  entries: z.array(TimeEntryDto),
});
export type ListTimeEntriesResponse = z.infer<typeof ListTimeEntriesResponse>;

export const TimerSyncDisposition = z.enum([
  'APPLIED',
  'ALREADY_APPLIED',
  'STALE',
  'FINALIZED',
  'CONFLICT',
]);
export type TimerSyncDisposition = z.infer<typeof TimerSyncDisposition>;

export const TimerSyncCorrection = z.enum([
  'CLOCK_CLAMP',
  'LEASE_FINALIZED',
  'SUPERSEDED',
]);
export type TimerSyncCorrection = z.infer<typeof TimerSyncCorrection>;

export const TimerSyncReceipt = z.object({
  disposition: TimerSyncDisposition,
  acceptedRevision: z.number().int().min(0),
  canonicalHash: z.string().length(64),
  canonicalEntry: TimeEntryDto,
  serverTime: Iso,
  correction: TimerSyncCorrection.nullable(),
});
export type TimerSyncReceipt = z.infer<typeof TimerSyncReceipt>;

export const TodayLedgerQuery = z.object({
  from: Iso,
  to: Iso,
}).superRefine((value, ctx) => {
  if (new Date(value.to).getTime() <= new Date(value.from).getTime()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'to must be after from' });
  }
});
export type TodayLedgerQuery = z.infer<typeof TodayLedgerQuery>;

export const TodayLedgerResponse = z.object({
  complete: z.literal(true),
  serverTime: Iso,
  workspaceTimezone: z.string().min(1),
  /** AUTO rows retain their original field for backwards compatibility. */
  entries: z.array(TimeEntryDto).max(2_000),
  /**
   * Approved manual rows are additive. Older agents ignore this unknown field;
   * newer agents treat an absent field from an older API as an empty list.
   */
  approvedManualEntries: z.array(TimeEntryDto).max(2_000).optional(),
  effectiveEntries: z.array(z.object({
    entryId: z.string().min(1),
    endedAt: Iso.nullable(),
    segments: z.array(z.object({
      segmentId: z.string().min(1),
      endedAt: Iso.nullable(),
    })),
  })).max(2_000),
});
export type TodayLedgerResponse = z.infer<typeof TodayLedgerResponse>;
