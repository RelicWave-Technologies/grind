import { z } from 'zod';

export const SegmentKind = z.enum(['WORK', 'MEETING', 'IDLE_TRIMMED']);
export type SegmentKind = z.infer<typeof SegmentKind>;

export const TimeEntrySource = z.enum(['AUTO', 'MANUAL']);
export type TimeEntrySource = z.infer<typeof TimeEntrySource>;

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
  startedAt: Iso,
  agentVersion: z.string().max(50).optional(),
  platform: z.enum(['darwin', 'win32', 'linux']).optional(),
  segments: z.array(SegmentDto).min(1),
});
export type CreateTimeEntryRequest = z.infer<typeof CreateTimeEntryRequest>;

export const TimeEntryDto = z.object({
  id: z.string(),
  clientUuid: z.string(),
  userId: z.string(),
  larkTaskGuid: z.string().nullable(),
  source: TimeEntrySource,
  startedAt: Iso,
  endedAt: Iso.nullable(),
  segments: z.array(SegmentDto),
});
export type TimeEntryDto = z.infer<typeof TimeEntryDto>;

/**
 * Sync the full segment list for an entry (agent is the source of truth for an
 * open entry). Server replaces segments + optionally closes the entry. This is
 * the idempotent "push my current state" call.
 */
export const SyncTimeEntryRequest = z.object({
  endedAt: Iso.nullable().optional(),
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
