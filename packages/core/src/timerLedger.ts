import type { SegmentKind, TimeEntrySource } from './types';

type Timestamp = number | string | Date;

export interface CanonicalTimerEntryLike {
  id: string;
  clientUuid: string;
  larkTaskGuid?: string | null;
  source: TimeEntrySource;
  revision: number | null;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  closeReason: string | null;
  segments: Array<{
    id: string;
    kind: SegmentKind;
    startedAt: Timestamp;
    endedAt: Timestamp | null;
  }>;
}

function epoch(value: Timestamp): number {
  if (typeof value === 'number') return value;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error('invalid_timer_timestamp');
  return parsed;
}

/** Stable agent-owned payload used for exact revision acknowledgement. */
export function canonicalTimerEntryPayload(entry: CanonicalTimerEntryLike): string {
  const segments = entry.segments
    .map((segment) => ({
      id: segment.id,
      kind: segment.kind,
      startedAt: epoch(segment.startedAt),
      endedAt: segment.endedAt === null ? null : epoch(segment.endedAt),
    }))
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));

  return JSON.stringify({
    id: entry.id,
    clientUuid: entry.clientUuid,
    larkTaskGuid: entry.larkTaskGuid ?? null,
    source: entry.source,
    revision: entry.revision ?? 0,
    startedAt: epoch(entry.startedAt),
    endedAt: entry.endedAt === null ? null : epoch(entry.endedAt),
    closeReason: entry.closeReason ?? null,
    segments,
  });
}
