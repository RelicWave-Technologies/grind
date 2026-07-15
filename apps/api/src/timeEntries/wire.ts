import { createHash } from 'node:crypto';
import type { TimeEntryCloseReason } from '@grind/db';
import { canonicalTimerEntryPayload } from '@grind/core';
import type {
  SegmentDto,
  TimerSyncCorrection,
  TimerSyncDisposition,
  TimerSyncReceipt,
  TimeEntryDto,
} from '@grind/types';

export interface SerializableTimeEntry {
  id: string;
  clientUuid: string;
  userId: string;
  larkTaskGuid: string | null;
  source: 'AUTO' | 'MANUAL';
  trackingProtocolVersion: number | null;
  agentRevision: number | null;
  lastProvenAt: Date | null;
  leaseExpiresAt: Date | null;
  closeReason: TimeEntryCloseReason | null;
  serverFinalizedAt: Date | null;
  startedAt: Date;
  endedAt: Date | null;
  notes: string | null;
  segments: Array<{
    id: string;
    kind: SegmentDto['kind'];
    startedAt: Date;
    endedAt: Date | null;
  }>;
}

export function serializeTimeEntry(entry: SerializableTimeEntry): TimeEntryDto {
  return {
    id: entry.id,
    clientUuid: entry.clientUuid,
    userId: entry.userId,
    larkTaskGuid: entry.larkTaskGuid,
    source: entry.source,
    trackingProtocolVersion: entry.trackingProtocolVersion,
    revision: entry.agentRevision,
    lastProvenAt: entry.lastProvenAt?.toISOString() ?? null,
    leaseExpiresAt: entry.leaseExpiresAt?.toISOString() ?? null,
    closeReason: entry.closeReason,
    serverFinalizedAt: entry.serverFinalizedAt?.toISOString() ?? null,
    startedAt: entry.startedAt.toISOString(),
    endedAt: entry.endedAt?.toISOString() ?? null,
    notes: entry.notes,
    segments: entry.segments
      .slice()
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id))
      .map((segment) => ({
        id: segment.id,
        kind: segment.kind,
        startedAt: segment.startedAt.toISOString(),
        endedAt: segment.endedAt?.toISOString() ?? null,
      })),
  };
}

export function canonicalTimeEntryHash(entry: TimeEntryDto): string {
  return createHash('sha256').update(canonicalTimerEntryPayload(entry)).digest('hex');
}

export function createTimerSyncReceipt(
  entry: SerializableTimeEntry,
  disposition: TimerSyncDisposition,
  correction: TimerSyncCorrection | null,
  serverTime = new Date(),
): TimerSyncReceipt {
  const canonicalEntry = serializeTimeEntry(entry);
  return {
    disposition,
    acceptedRevision: canonicalEntry.revision ?? 0,
    canonicalHash: canonicalTimeEntryHash(canonicalEntry),
    canonicalEntry,
    serverTime: serverTime.toISOString(),
    correction,
  };
}
