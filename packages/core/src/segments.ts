import { COUNTED_KINDS, type Segment, type SegmentKind, type TimeEntry, type TimeEntrySource } from './types';

/**
 * Pure time-entry / segment domain logic.
 *
 * A TimeEntry is a unit of tracked work, composed of non-overlapping, ordered
 * Segments. Worked duration = sum of WORK + MEETING segments. IDLE_TRIMMED
 * segments are recorded for the timeline (shown as "idle") but never counted.
 *
 * Invariants (enforced by `validateEntry`):
 *  - At most one open segment (endedAt === null), and it must be the last one.
 *  - Segments are ordered by startedAt and never overlap.
 *  - Every segment has endedAt === null OR endedAt >= startedAt.
 *  - entry.startedAt === segments[0].startedAt (when any segment exists).
 *  - If entry.endedAt !== null, no segment is open.
 *
 * All functions are pure: they return a new TimeEntry and never mutate input.
 */

export class SegmentError extends Error {}

function cloneSegments(segments: Segment[]): Segment[] {
  return segments.map((s) => ({ ...s }));
}

function openIndex(segments: Segment[]): number {
  return segments.findIndex((s) => s.endedAt === null);
}

export function getOpenSegment(entry: TimeEntry): Segment | null {
  const i = openIndex(entry.segments);
  return i === -1 ? null : entry.segments[i]!;
}

export interface CreateArgs {
  id: string;
  clientUuid: string;
  userId: string;
  larkTaskGuid?: string | null;
  source?: TimeEntrySource;
  startedAt: number;
  segmentId: string;
}

/** Create a new running entry with a single open WORK segment. */
export function createTimeEntry(args: CreateArgs): TimeEntry {
  return {
    id: args.id,
    clientUuid: args.clientUuid,
    userId: args.userId,
    larkTaskGuid: args.larkTaskGuid ?? null,
    source: args.source ?? 'AUTO',
    revision: 1,
    startedAt: args.startedAt,
    endedAt: null,
    pauseReason: null,
    closeReason: null,
    segments: [{ id: args.segmentId, kind: 'WORK', startedAt: args.startedAt, endedAt: null }],
  };
}

/** Close the currently-open segment at `at`. No-op if nothing is open (idempotent). */
export function closeOpenSegment(entry: TimeEntry, at: number): TimeEntry {
  const i = openIndex(entry.segments);
  if (i === -1) return entry;
  const open = entry.segments[i]!;
  if (at < open.startedAt) {
    throw new SegmentError(`closeOpenSegment: at (${at}) < segment.startedAt (${open.startedAt})`);
  }
  const segments = cloneSegments(entry.segments);
  segments[i] = { ...open, endedAt: at };
  return { ...entry, revision: entry.revision + 1, segments };
}

/**
 * Close any open segment at `at`, then append a new open segment of `kind`
 * starting at `at`. Used for WORK -> MEETING transitions and resume-after-idle.
 */
export function openSegment(
  entry: TimeEntry,
  args: { kind: SegmentKind; at: number; segmentId: string },
): TimeEntry {
  if (entry.endedAt !== null) {
    throw new SegmentError('openSegment: cannot open a segment on a closed entry');
  }
  const closed = closeOpenSegment(entry, args.at);
  const last = closed.segments[closed.segments.length - 1];
  if (last && args.at < (last.endedAt ?? last.startedAt)) {
    throw new SegmentError(`openSegment: at (${args.at}) precedes previous segment end`);
  }
  const segments = cloneSegments(closed.segments);
  segments.push({ id: args.segmentId, kind: args.kind, startedAt: args.at, endedAt: null });
  return { ...closed, revision: entry.revision + 1, pauseReason: null, closeReason: null, segments };
}

/** Close the open segment (if any) and mark the entry finished at `at`. Idempotent. */
export function closeTimeEntry(entry: TimeEntry, at: number): TimeEntry {
  if (entry.endedAt !== null) return entry;
  const closed = closeOpenSegment(entry, at);
  return { ...closed, revision: entry.revision + 1, endedAt: at, pauseReason: null, closeReason: 'AGENT' };
}

/**
 * Crash / unexpected-shutdown recovery: an entry was left with an open segment,
 * but we only trust activity up to `lastKnownActiveAt`. Close the open segment
 * there and finish the entry, so we never over-credit the offline gap.
 */
export function recoverStaleEntry(entry: TimeEntry, lastKnownActiveAt: number): TimeEntry {
  if (entry.endedAt !== null) return entry;
  const open = getOpenSegment(entry);
  const at = open ? Math.max(lastKnownActiveAt, open.startedAt) : lastKnownActiveAt;
  return closeTimeEntry(entry, at);
}

/**
 * Total worked milliseconds (WORK + MEETING). The open segment, if any, is
 * counted up to `now`. Throws if there is an open segment and `now` is omitted.
 */
export function totalWorkedMs(entry: TimeEntry, now?: number): number {
  let total = 0;
  for (const s of entry.segments) {
    if (!COUNTED_KINDS.includes(s.kind)) continue;
    const end = s.endedAt ?? now;
    if (end === undefined) {
      throw new SegmentError('totalWorkedMs: open segment requires `now`');
    }
    total += Math.max(0, end - s.startedAt);
  }
  return total;
}

/** Total milliseconds recorded as trimmed idle (for timeline/audit display). */
export function totalIdleTrimmedMs(entry: TimeEntry): number {
  let total = 0;
  for (const s of entry.segments) {
    if (s.kind !== 'IDLE_TRIMMED') continue;
    if (s.endedAt === null) continue;
    total += Math.max(0, s.endedAt - s.startedAt);
  }
  return total;
}

/** Validate all invariants. Returns the list of violations (empty = valid). */
export function validateEntry(entry: TimeEntry): string[] {
  const errors: string[] = [];
  const segs = entry.segments;

  if (segs.length === 0) {
    errors.push('entry has no segments');
    return errors;
  }

  if (entry.startedAt !== segs[0]!.startedAt) {
    errors.push(`entry.startedAt (${entry.startedAt}) !== first segment.startedAt (${segs[0]!.startedAt})`);
  }

  const seenIds = new Set<string>();
  let openCount = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (seenIds.has(s.id)) errors.push(`duplicate segment id ${s.id}`);
    seenIds.add(s.id);
    if (s.endedAt === null) {
      openCount++;
      if (i !== segs.length - 1) errors.push(`open segment at index ${i} is not last`);
    } else if (s.endedAt < s.startedAt) {
      errors.push(`segment ${i}: endedAt (${s.endedAt}) < startedAt (${s.startedAt})`);
    }
    if (i > 0) {
      const prev = segs[i - 1]!;
      const prevEnd = prev.endedAt ?? prev.startedAt;
      if (s.startedAt < prevEnd) {
        errors.push(`segment ${i} overlaps previous (start ${s.startedAt} < prev end ${prevEnd})`);
      }
    }
  }

  if (openCount > 1) errors.push(`${openCount} open segments (max 1)`);
  if (entry.endedAt !== null && openCount > 0) errors.push('entry closed but has an open segment');

  return errors;
}
