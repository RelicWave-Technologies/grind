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

/**
 * Whole milliseconds, the precision the server stores. Agents before beta.38
 * persisted fractional timestamps; truncating here lets those rows hash equal
 * to the server's copy instead of staying unacknowledged forever.
 */
function epoch(value: Timestamp): number {
  const parsed = typeof value === 'number'
    ? value
    : value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error('invalid_timer_timestamp');
  return Math.trunc(parsed);
}

/**
 * Stable agent-owned payload used for exact revision acknowledgement.
 *
 * Zero-length segments are left out: the server never stores them (see
 * ZERO-LENGTH SEGMENTS in segments.ts), so an entry is hashed the way it will
 * be stored and a local copy still holding one matches the server's receipt.
 */
export function canonicalTimerEntryPayload(entry: CanonicalTimerEntryLike): string {
  const segments = entry.segments
    .map((segment) => ({
      id: segment.id,
      kind: segment.kind,
      startedAt: epoch(segment.startedAt),
      endedAt: segment.endedAt === null ? null : epoch(segment.endedAt),
    }))
    // After `epoch`, so a sub-millisecond span counts as the zero it arrives as.
    .filter((segment) => segment.endedAt === null || segment.endedAt !== segment.startedAt)
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
