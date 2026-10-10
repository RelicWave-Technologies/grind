import {
  effectiveEntrySegmentEnds,
  type EntryLiveEvidenceMap,
  type TimerLifecycleEvidence,
} from './evidence';
import {
  clipInterval,
  mergeIntervals,
  resolveByPriority,
  splitByIntervals,
  type Interval,
} from './intervals';

/**
 * One timeline, one owner per instant, per person.
 *
 * Every surface that shows time — Edit Time, Home, the reports grid and popup,
 * the overview, Lark task totals, the agent's ledger, the month report — reads
 * through this. It applies three rules, once:
 *
 *  1. **Open ends are proven, not assumed.** An open segment counts only as far
 *     as the live evidence reaches (see `effectiveSegmentEnd`).
 *  2. **Real time wins.** Where entries overlap, tracked work and meetings keep
 *     the minute, approved manual time keeps only what is free, and trimmed
 *     idle keeps what is left. Each instant is counted once, under one owner.
 *  3. **Invalidated time is time that does not count.** A reviewer's
 *     invalidation does not delete anything; the pieces it covers are kept and
 *     flagged, so a screen can still draw them, and no total includes them.
 *
 * Pure; the API's `loadTimeline` does the I/O.
 */

export type TimelineKind = 'WORK' | 'MEETING' | 'MANUAL' | 'IDLE';

export interface TimelineSegment {
  kind: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface TimelineEntry extends TimerLifecycleEvidence {
  id: string;
  userId: string;
  /** 'AUTO' (agent-tracked) or 'MANUAL' (approved manual time). */
  source: string;
  larkTaskGuid?: string | null;
  endedAt?: Date | null;
  segments: readonly TimelineSegment[];
}

export interface TimelineInvalidation {
  userId: string;
  start: number;
  end: number;
}

export interface TimelinePiece<E = TimelineEntry> {
  userId: string;
  entry: E;
  kind: TimelineKind;
  start: number;
  end: number;
  /** Covered by a reviewer's invalidation: drawn, never counted. */
  invalidated: boolean;
  /** The segment is still running (its end is `now`, not a stored end). */
  live: boolean;
}

/** Ranking for contested minutes. Higher wins. */
export const CLAIM_PRIORITY = { tracked: 2, manual: 1, idle: 0 } as const;

export function timelineKindOf(source: string, segmentKind: string): TimelineKind {
  if (segmentKind === 'IDLE_TRIMMED') return 'IDLE';
  if (source === 'MANUAL') return 'MANUAL';
  return segmentKind === 'MEETING' ? 'MEETING' : 'WORK';
}

export function claimPriority(kind: TimelineKind): number {
  if (kind === 'WORK' || kind === 'MEETING') return CLAIM_PRIORITY.tracked;
  if (kind === 'MANUAL') return CLAIM_PRIORITY.manual;
  return CLAIM_PRIORITY.idle;
}

/** Work, meetings and manual time that no invalidation covers. */
export function isCounted(piece: Pick<TimelinePiece, 'kind' | 'invalidated'>): boolean {
  return piece.kind !== 'IDLE' && !piece.invalidated;
}

/** Agent-observed work or meeting that no invalidation covers. */
export function isTracked(piece: Pick<TimelinePiece, 'kind' | 'invalidated'>): boolean {
  return (piece.kind === 'WORK' || piece.kind === 'MEETING') && !piece.invalidated;
}

export interface ResolveTimelineOptions {
  /** The clock every open end is measured against; nothing counts past it. */
  now: Date | number;
  /** Live evidence for open entries (heartbeats, proofs), keyed by entry id. */
  evidence?: EntryLiveEvidenceMap | null;
  /**
   * The segments' ends are already effective (a caller resolved them): an open
   * segment is simply live to `now`. Without this, open ends are proven
   * against `evidence`.
   */
  trustOpenSegments?: boolean;
  invalidations?: readonly TimelineInvalidation[];
  /** Optional clip window. Leave unset when day attribution needs lookback. */
  window?: Interval;
}

interface RawPiece<E extends TimelineEntry> extends Interval {
  userId: string;
  entry: E;
  kind: TimelineKind;
  live: boolean;
}

/** Resolve entries into the single, non-overlapping timeline for each person. */
export function resolveTimeline<E extends TimelineEntry>(
  entries: readonly E[],
  opts: ResolveTimelineOptions,
): Array<TimelinePiece<E>> {
  const nowMs = typeof opts.now === 'number' ? opts.now : opts.now.getTime();
  const nowDate = Number.isFinite(nowMs) ? new Date(nowMs) : null;

  const byUser = new Map<string, Array<RawPiece<E>>>();
  for (const entry of entries) {
    const ends: Array<Date | null> = opts.trustOpenSegments || !nowDate
      ? entry.segments.map((s) => s.endedAt)
      : effectiveEntrySegmentEnds({
          segments: entry.segments,
          entryEndedAt: entry.endedAt ?? null,
          now: nowDate,
          evidence: opts.evidence?.get(entry.id) ?? null,
          lifecycle: entry,
        });
    entry.segments.forEach((segment, index) => {
      const effectiveEnd = ends[index] ?? null;
      const live = effectiveEnd === null;
      let iv: Interval | null = {
        start: segment.startedAt.getTime(),
        end: Math.min(live ? nowMs : effectiveEnd.getTime(), nowMs),
      };
      if (opts.window) iv = clipInterval(iv, opts.window.start, opts.window.end);
      if (!iv || iv.end <= iv.start) return;
      const list = byUser.get(entry.userId) ?? [];
      list.push({
        ...iv,
        userId: entry.userId,
        entry,
        kind: timelineKindOf(entry.source, segment.kind),
        live,
      });
      byUser.set(entry.userId, list);
    });
  }

  const invalidationsByUser = new Map<string, Interval[]>();
  for (const inv of opts.invalidations ?? []) {
    const list = invalidationsByUser.get(inv.userId) ?? [];
    list.push({ start: inv.start, end: inv.end });
    invalidationsByUser.set(inv.userId, list);
  }

  const out: Array<TimelinePiece<E>> = [];
  for (const userId of [...byUser.keys()].sort()) {
    const resolved = resolveByPriority(byUser.get(userId)!, (p) => claimPriority(p.kind));
    const cuts = mergeIntervals(invalidationsByUser.get(userId) ?? []);
    for (const part of splitByIntervals(resolved, cuts)) {
      out.push({
        userId,
        entry: part.item.entry,
        kind: part.item.kind,
        start: part.start,
        end: part.end,
        invalidated: part.inside && part.item.kind !== 'IDLE',
        live: part.item.live && part.end === part.item.end,
      });
    }
  }
  return out;
}

/** Invalidation windows grouped per person and merged. */
export function invalidationsByUser(
  invalidations: readonly TimelineInvalidation[] | undefined,
): Map<string, Interval[]> {
  const grouped = new Map<string, Interval[]>();
  for (const inv of invalidations ?? []) {
    const list = grouped.get(inv.userId) ?? [];
    list.push({ start: inv.start, end: inv.end });
    grouped.set(inv.userId, list);
  }
  for (const [userId, list] of grouped) grouped.set(userId, mergeIntervals(list));
  return grouped;
}

/**
 * Counted time per Lark task, optionally within a window. Read from the
 * resolved timeline, so the per-task figures can never add up to more than the
 * day: a minute two tasks both claim belongs to one of them.
 */
export function totalsByTask(
  pieces: ReadonlyArray<TimelinePiece<{ larkTaskGuid?: string | null }>>,
  window?: Interval,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const piece of pieces) {
    if (!isCounted(piece)) continue;
    const guid = piece.entry.larkTaskGuid;
    if (!guid) continue;
    const iv = window ? clipInterval(piece, window.start, window.end) : piece;
    if (!iv) continue;
    out.set(guid, (out.get(guid) ?? 0) + (iv.end - iv.start));
  }
  return out;
}

/**
 * Who is tracking right now, and on which entry (userId → entry id).
 *
 * A live piece is a running segment whose end is `now` — proven by the same
 * rule that lets it count (a fresh heartbeat, or a v2 lease), so "tracking
 * now" cannot disagree with the minutes the screens are adding up. An
 * invalidated stretch still has a running timer; manual and idle time never do.
 */
export function trackingNow<E extends { id: string }>(
  pieces: ReadonlyArray<Pick<TimelinePiece<E>, 'userId' | 'entry' | 'kind' | 'live'>>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const piece of pieces) {
    if (piece.live && (piece.kind === 'WORK' || piece.kind === 'MEETING')) out.set(piece.userId, piece.entry.id);
  }
  return out;
}

/** Counted milliseconds of `pieces` inside `window` (whole timeline when unset). */
export function countedMs(pieces: ReadonlyArray<TimelinePiece<unknown>>, window?: Interval): number {
  let total = 0;
  for (const piece of pieces) {
    if (!isCounted(piece)) continue;
    const iv = window ? clipInterval(piece, window.start, window.end) : piece;
    if (iv) total += iv.end - iv.start;
  }
  return total;
}
