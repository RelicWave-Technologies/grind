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
 *  - entry.startedAt <= segments[0].startedAt (when any segment exists).
 *  - If entry.endedAt !== null, no segment is open.
 *
 * ZERO-LENGTH SEGMENTS — one rule, agent and server:
 *
 *  A closed segment that starts and ends at the same instant carried no time,
 *  so it is not part of the entry. It is REMOVED, never kept as an empty span:
 *
 *  - At the source. Closing a segment at its own start (a pause, idle or
 *    permission cut that lands on the segment start, start→stop or a task
 *    switch in the same millisecond, crash recovery at the start) removes the
 *    segment — `closeOpenSegment`, `openSegment`, `closeTimeEntry` and
 *    `recoverStaleEntry` all do it. The agent builds entries only through
 *    these, so it never produces one.
 *  - Removing a segment never moves the entry. `entry.startedAt` stays where
 *    the timer was started, so it may precede the first remaining segment,
 *    and an entry can be left with no segments at all. Such an entry is real
 *    (it may already exist on the server and must be closed there); it simply
 *    counts zero time. It is synced like any other, never discarded.
 *  - At the server boundary. Agents up to beta.38 still send zero-length
 *    segments. `validateEntry` tolerates them — they are not a violation, so
 *    an old agent never gets a 400 for one — and `clampEntryToServerClock`
 *    drops them before anything is stored, reporting them in `dropped`,
 *    separately from clock clamps. Dropping one is not a clock correction.
 *    `dropZeroLengthSegments` is the same rule for callers that hash or
 *    compare an entry the way the server will store it.
 *
 * "Zero-length" is judged at millisecond resolution, the wire's: an agent
 * timestamp's fraction of a millisecond does not survive the ISO string.
 *
 * Inverted segments (endedAt < startedAt) are still invalid everywhere.
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

/**
 * Same instant at the wire's resolution. Agent timestamps can carry fractions
 * of a millisecond; ISO strings (and the server's Dates) truncate them, so a
 * span shorter than a millisecond inside one millisecond arrives as zero.
 */
function sameMillisecond(a: number, b: number): boolean {
  return Math.trunc(a) === Math.trunc(b);
}

/** True for a closed segment that carried no time (see ZERO-LENGTH SEGMENTS). */
export function isZeroLengthSegment(segment: Segment): boolean {
  return segment.endedAt !== null && sameMillisecond(segment.endedAt, segment.startedAt);
}

/**
 * The entry without its zero-length segments, and which ones were removed.
 * Returns the same object when there are none. Never touches the revision:
 * this is how an entry is stored, not a new local mutation.
 */
export function dropZeroLengthSegments(entry: TimeEntry): { entry: TimeEntry; droppedIds: string[] } {
  const droppedIds = entry.segments.filter(isZeroLengthSegment).map((s) => s.id);
  if (droppedIds.length === 0) return { entry, droppedIds };
  return {
    entry: { ...entry, segments: cloneSegments(entry.segments.filter((s) => !isZeroLengthSegment(s))) },
    droppedIds,
  };
}

/**
 * Close the currently-open segment at `at`. No-op if nothing is open (idempotent).
 * Closing it at its own start removes it: it carried no time.
 */
export function closeOpenSegment(entry: TimeEntry, at: number): TimeEntry {
  const i = openIndex(entry.segments);
  if (i === -1) return entry;
  const open = entry.segments[i]!;
  if (at < open.startedAt) {
    throw new SegmentError(`closeOpenSegment: at (${at}) < segment.startedAt (${open.startedAt})`);
  }
  const segments = cloneSegments(entry.segments);
  if (sameMillisecond(at, open.startedAt)) segments.splice(i, 1);
  else segments[i] = { ...open, endedAt: at };
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

  // No segments is valid: everything the entry held was zero-length (see
  // ZERO-LENGTH SEGMENTS). It counts no time but still has to be closed.
  if (segs.length === 0) return errors;

  // `<=`, not `===`: a dropped zero-length first segment leaves the entry
  // starting before its first remaining segment, and the server keeps the
  // start it stored at create (clamped, if the clock was ahead) while later
  // syncs carry the agent's own segment starts.
  if (entry.startedAt > segs[0]!.startedAt) {
    errors.push(`entry.startedAt (${entry.startedAt}) > first segment.startedAt (${segs[0]!.startedAt})`);
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
