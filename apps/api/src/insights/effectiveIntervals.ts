import type { EntryLiveEvidenceMap } from './liveEntryEvidence';
import { resolveEffectiveEntrySegmentEnds } from './openSegmentEvidence';

export interface EffectiveInterval {
  start: number;
  end: number;
}

export interface EffectiveIntervalEntry {
  id?: string;
  endedAt?: Date | null;
  trackingProtocolVersion?: number | null;
  lastProvenAt?: Date | null;
  leaseExpiresAt?: Date | null;
  segments: Array<{ kind: string; startedAt: Date; endedAt: Date | null }>;
}

export function collectEffectiveIntervals(
  entry: EffectiveIntervalEntry,
  input: {
    now: Date;
    windowStart?: number;
    windowEnd?: number;
    evidenceByEntry?: EntryLiveEvidenceMap;
    includeSegment?: (segment: { kind: string; startedAt: Date; endedAt: Date | null }) => boolean;
  },
): EffectiveInterval[] {
  const nowMs = input.now.getTime();
  const windowStart = input.windowStart ?? Number.NEGATIVE_INFINITY;
  const windowEnd = input.windowEnd ?? nowMs;
  const effectiveEnds = resolveEffectiveEntrySegmentEnds({
    segments: entry.segments,
    entryEndedAt: entry.endedAt,
    now: input.now,
    evidence: entry.id ? input.evidenceByEntry?.get(entry.id) : null,
    lifecycle: entry,
  });

  const intervals: EffectiveInterval[] = [];
  for (const [index, segment] of entry.segments.entries()) {
    if (input.includeSegment && !input.includeSegment(segment)) continue;
    const start = Math.max(segment.startedAt.getTime(), windowStart);
    const effectiveEnd = effectiveEnds[index];
    const end = Math.min((effectiveEnd ?? input.now).getTime(), windowEnd, nowMs);
    if (end > start) intervals.push({ start, end });
  }
  return intervals;
}

export function mergeIntervals(intervals: ReadonlyArray<EffectiveInterval>): EffectiveInterval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: EffectiveInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end) {
      merged.push({ ...interval });
      continue;
    }
    last.end = Math.max(last.end, interval.end);
  }
  return merged;
}

export function intervalUnionMs(intervals: ReadonlyArray<EffectiveInterval>): number {
  return mergeIntervals(intervals).reduce((sum, interval) => sum + interval.end - interval.start, 0);
}
