/**
 * Pure helpers for the per-day timeline ("Edit Time" tab).
 *
 * Strategy:
 *   1. Compute the local-day window in the user's IANA timezone (DST-correct).
 *   2. Clip every TimeSegment that overlaps the window.
 *   3. Tag each clipped segment with a kind that the UI renders directly:
 *        - WORK / MEETING / IDLE_TRIMMED come straight from the segment kind
 *        - MANUAL overrides them when the parent TimeEntry.source === 'MANUAL'
 *   4. Compute GAP blocks between adjacent non-gap blocks, but only inside
 *      [firstActivityAt .. lastActivityAt] (or .. now for today). Outside that
 *      envelope we don't fabricate a "you were idle since midnight" — the user
 *      just hadn't started yet.
 *   5. Surface PENDING ManualTimeRequests overlapping the window as a separate
 *      array so the UI can render a striped overlay without confusing them
 *      with real, already-approved blocks.
 *
 * The owner of every minute comes from `@grind/core`'s `resolveTimeline` —
 * the same resolution the reports, the overview and Lark read — so this view
 * cannot count a minute another screen does not. Invalidated minutes stay on
 * the timeline (flagged) but never reach worked/meeting/manual totals.
 *
 * No prisma/network calls in this file. The route owns I/O; this owns logic.
 */

import {
  clipInterval,
  firstStretchStartWithin,
  isCounted,
  mergeIntervals,
  resolveTimeline,
  subtractIntervals,
  type Interval,
  type TimelinePiece,
} from '@grind/core';
import { localDayWindowInTimeZone } from '@grind/types';

type SegmentKind = 'WORK' | 'MEETING' | 'IDLE_TRIMMED';
/**
 * Every minute of the day belongs to exactly ONE block kind — the timeline is a
 * single partition (Time-Doctor style), no overlapping layers. PENDING requests
 * are carved out of the gaps they sit in, so a pending slot is never *also* a
 * gap row (that was the old "duplicacy").
 */
type BlockKind = SegmentKind | 'MANUAL' | 'PENDING' | 'GAP';

/** What a day block needs to know about the entry behind it. */
export interface DayEntryMeta {
  id: string;
  source: 'AUTO' | 'MANUAL';
  requestId?: string | null;
  larkTaskGuid: string | null;
  notes?: string | null;
  attendeeIds?: string[];
}

export interface DayEntryInput {
  id: string;
  source: 'AUTO' | 'MANUAL';
  requestId?: string | null;
  larkTaskGuid: string | null;
  notes?: string | null;
  attendeeIds?: string[];
  segments: Array<{
    kind: SegmentKind;
    startedAt: Date;
    endedAt: Date | null; // null => still running
  }>;
}

export interface PendingRequestInput {
  id: string;
  requestedStart: Date;
  requestedEnd: Date;
  reason: string;
  larkTaskGuid: string | null;
  taskSummary?: string | null;
  attendeeIds?: string[];
}

export interface RejectedRequestInput extends PendingRequestInput {
  decidedReason: string | null;
}

interface DayBlock {
  kind: BlockKind;
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms (exclusive)
  durationMs: number;
  timeEntryId?: string;
  larkTaskGuid?: string | null;
  taskSummary?: string | null;
  /**
   * For tracked + APPROVED MANUAL blocks, this is the TimeEntry.notes the
   * user can edit inline. For GAP blocks it's null.
   */
  notes?: string | null;
  isOpen?: boolean;
  /**
   * Workspace user-ids tagged as attendees. Populated for MEETING + MANUAL
   * blocks (any block whose underlying entry has TimeEntryAttendee rows).
   * Absent for WORK/IDLE/GAP.
   */
  attendeeIds?: string[];
  /** ManualTimeRequest id for PENDING and approved MANUAL blocks. */
  requestId?: string;
  /** PENDING blocks only: the request reason (shown + editable inline). */
  reason?: string;
  /** A reviewer invalidated these minutes: drawn, never counted. */
  invalidated?: boolean;
}

export interface DayInsightResult {
  date: string;
  timezone: string;
  /** True local midnight-to-midnight bounds used by full-day visualizations. */
  calendarDayStart: number;
  calendarDayEnd: number;
  /** Caller-selected review bounds used by the editable partition and gap totals. */
  dayStart: number;
  dayEnd: number;
  isFuture: boolean;
  isToday: boolean;
  /**
   * The assigned shift, when this is a scheduled workday. Its exact instants
   * let clients mark the shift independently from the caller-selected review
   * window. Edit Time may review the calendar day while reports stay bounded.
   */
  shift: {
    name: string;
    start: string;
    end: string;
    startedAt: number;
    endedAt: number;
  } | null;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
  totals: {
    workedMs: number;
    meetingMs: number;
    manualMs: number;
    idleTrimmedMs: number;
    pendingMs: number;
    gapMs: number;
    /** Work/meeting/manual minutes a reviewer invalidated (excluded above). */
    invalidatedMs: number;
  };
  /**
   * The single sorted review partition: tracked · meeting · manual · idle ·
   * pending · gap, contiguous and non-overlapping across [dayStart, dayEnd]
   * (capped at `now` for today). No gap is fabricated outside the frame chosen
   * by the caller.
   */
  blocks: DayBlock[];
  /**
   * REJECTED manual-time requests overlapping the day. Rendered as read-only
   * context (not part of the partition — they didn't become time). The user can
   * re-request; `decidedReason` explains the rejection.
   */
  recentRejected: Array<{
    id: string;
    requestedStart: number;
    requestedEnd: number;
    reason: string;
    decidedReason: string | null;
    larkTaskGuid: string | null;
  }>;
}

/**
 * Compute the local-day window for `date` (YYYY-MM-DD) in IANA `tz`. Returns
 * `null` if either input is invalid. DST-correct: a 23h spring-forward day
 * returns end-start = 23h.
 */
export function localDayWindow(date: string, tz: string): { start: Date; end: Date } | null {
  return localDayWindowInTimeZone(date, tz);
}

interface PendingIv {
  id: string;
  a: number;
  b: number;
  reason: string;
  larkTaskGuid: string | null;
  taskSummary?: string | null;
  attendeeIds?: string[];
}

/**
 * Carve PENDING requests exactly the way approving them will: a request keeps
 * only what is not already tracked or approved manual time. Trimmed idle does
 * not block it — correcting a bad idle trim is the main thing manual time is
 * for — so a pending stripe can sit where idle was drawn. Overlapping requests
 * are de-overlapped first-come (earliest start), so the partition stays clean.
 */
function carvePending(pendingIv: PendingIv[], occupied: Interval[], lo: number, hi: number): DayBlock[] {
  const out: DayBlock[] = [];
  let taken = mergeIntervals(occupied);
  for (const p of pendingIv) {
    const win = clipInterval({ start: p.a, end: p.b }, lo, hi);
    if (!win) continue;
    for (const part of subtractIntervals([win], taken)) {
      out.push({
        kind: 'PENDING',
        startedAt: part.start,
        endedAt: part.end,
        durationMs: part.end - part.start,
        requestId: p.id,
        reason: p.reason,
        larkTaskGuid: p.larkTaskGuid,
        taskSummary: p.taskSummary ?? null,
        ...(p.attendeeIds ? { attendeeIds: p.attendeeIds } : {}),
      });
    }
    taken = mergeIntervals([...taken, win]);
  }
  return out;
}

/** Sub-`COALESCE_MIN_MS` idle/gaps fold INTO the surrounding work; adjacent
 *  same-kind + same-task work merges into one continuous block. Time-Doctor
 *  style — totals are computed from the raw partition BEFORE this, so folding a
 *  short idle into work never changes the hour counts. */
const COALESCE_MIN_MS = 120_000; // 2 minutes

function isTracked(k: BlockKind): boolean {
  return k === 'WORK' || k === 'MEETING' || k === 'MANUAL';
}
function isFiller(k: BlockKind): boolean {
  return k === 'GAP' || k === 'IDLE_TRIMMED';
}

/**
 * Collapse ONE same-task run of tracked blocks into display blocks. The run's
 * DOMINANT kind (by duration) wins; sub-`minMs` kind-flaps (e.g. a 30-second
 * MEETING blip between WORK segments — leftover from old meeting detection)
 * fold into the dominant block. A contiguous same-kind sub-run lasting ≥ minMs
 * (a *real* meeting inside a task) survives as its own block. The merged block
 * keeps the first constituent's entry id for inline edits.
 */
function emitRun(run: DayBlock[], minMs: number): DayBlock[] {
  if (run.length === 0) return [];
  const kindMs: Record<string, number> = {};
  for (const b of run) kindMs[b.kind] = (kindMs[b.kind] ?? 0) + b.durationMs;
  const dominant = (Object.entries(kindMs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? run[0]!.kind) as BlockKind;

  const out: DayBlock[] = [];
  let cur: DayBlock | null = null;
  const flush = () => {
    if (cur) {
      cur.durationMs = cur.endedAt - cur.startedAt;
      out.push(cur);
      cur = null;
    }
  };

  let j = 0;
  while (j < run.length) {
    const b = run[j]!;
    if (b.kind !== dominant) {
      // Length of the contiguous same-kind sub-run starting at j.
      let k = j;
      while (k + 1 < run.length && run[k + 1]!.kind === b.kind) k++;
      const subEnd = run[k]!.endedAt;
      if (subEnd - b.startedAt >= minMs) {
        // A real, distinct-kind activity (e.g. a genuine meeting) → its own row.
        flush();
        const att = new Set<string>();
        for (let x = j; x <= k; x++) for (const a of run[x]!.attendeeIds ?? []) att.add(a);
        out.push({
          ...b,
          endedAt: subEnd,
          durationMs: subEnd - b.startedAt,
          isOpen: run[k]!.isOpen,
          ...(att.size ? { attendeeIds: [...att] } : {}),
        });
        j = k + 1;
        continue;
      }
      // else: short flap → fold into the dominant block below.
    }
    if (!cur) cur = { ...b, kind: dominant };
    cur.endedAt = Math.max(cur.endedAt, b.endedAt);
    if (b.attendeeIds?.length) cur.attendeeIds = [...new Set([...(cur.attendeeIds ?? []), ...b.attendeeIds])];
    if (b.isOpen) cur.isOpen = true;
    j++;
  }
  flush();
  return out;
}

/**
 * Collapse the raw partition into a clean display list (Time-Doctor style):
 *  - short (< minMs) GAP/IDLE slivers fold into the surrounding work;
 *  - a same-task run of tracked blocks collapses to its dominant kind, folding
 *    sub-minMs kind-flaps in (see {@link emitRun});
 *  - long gaps/idle (real breaks), real (≥minMs) meetings, PENDING requests,
 *    and leading slivers are preserved as their own rows.
 * Totals are computed from the RAW partition before this, so folding never
 * changes the hour counts.
 */
function coalesceForDisplay(blocks: DayBlock[], minMs: number): DayBlock[] {
  const out: DayBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    if (isFiller(b.kind)) {
      const prev = out[out.length - 1];
      if (b.durationMs < minMs && prev && isTracked(prev.kind) && !prev.invalidated) {
        prev.endedAt = Math.max(prev.endedAt, b.endedAt);
        prev.durationMs = prev.endedAt - prev.startedAt;
        prev.isOpen = false;
      } else {
        out.push({ ...b });
      }
      i++;
      continue;
    }
    if (!isTracked(b.kind)) {
      out.push({ ...b }); // PENDING — a distinct request, never merged.
      i++;
      continue;
    }
    // Gather a same-task tracked run, absorbing short fillers between members.
    const task = b.larkTaskGuid ?? null;
    const run: DayBlock[] = [b];
    let runEnd = b.endedAt;
    i++;
    while (i < blocks.length) {
      const n = blocks[i]!;
      if (isFiller(n.kind)) {
        if (n.durationMs < minMs && n.startedAt - runEnd < minMs) {
          runEnd = Math.max(runEnd, n.endedAt);
          i++;
          continue;
        }
        break; // a real break ends the run
      }
      if (!isTracked(n.kind)) break; // PENDING
      if ((n.larkTaskGuid ?? null) !== task) break; // task change
      if (Boolean(n.invalidated) !== Boolean(b.invalidated)) break; // counted vs invalidated
      if (n.startedAt - runEnd >= minMs) break; // long intra-task gap
      run.push(n);
      runEnd = Math.max(runEnd, n.endedAt);
      i++;
    }
    const emitted = emitRun(run, minMs);
    if (emitted.length > 0) {
      // Extend the last block over any trailing short filler absorbed into the run.
      const last = emitted[emitted.length - 1]!;
      last.endedAt = Math.max(last.endedAt, runEnd);
      last.durationMs = last.endedAt - last.startedAt;
    }
    out.push(...emitted);
  }
  return out;
}

const DAY_USER = 'day';

function blockKindOf(kind: TimelinePiece['kind']): BlockKind {
  return kind === 'IDLE' ? 'IDLE_TRIMMED' : kind;
}

/**
 * Main composer — builds the single, contiguous, non-overlapping day partition.
 * `now` lets tests be deterministic. `frame` is the shift window (or full day);
 * `calendarDay` is the true midnight→midnight span (drives isToday/isFuture and
 * caps the frame so it can never exceed the calendar day).
 *
 * Time comes in one of two shapes: `timeline`, pieces already resolved by
 * `@grind/core` (what the routes pass), or `entries` whose segment ends are
 * already effective (`null` = running), resolved here by the same rule.
 */
export function buildDayInsight(input: {
  date: string;
  tz: string;
  now: Date;
  entries?: DayEntryInput[];
  timeline?: ReadonlyArray<TimelinePiece<DayEntryMeta>>;
  /** Reviewer invalidations, applied when time comes in as `entries`. */
  invalidations?: readonly Interval[];
  pending: PendingRequestInput[];
  rejected?: RejectedRequestInput[];
  /** Shift-bounded window (or full day when no shift / day off). */
  window: { start: Date; end: Date };
  /** True calendar midnight→midnight, for isToday/isFuture + frame capping.
   *  Defaults to `window` when omitted (the full-day, no-shift case). */
  calendarDay?: { start: Date; end: Date };
  /** Shift label, or null when the window is the full calendar day. */
  shift?: { name: string; start: string; end: string } | null;
  /** Exact shift instants. Defaults to `window` for backwards-compatible callers. */
  shiftWindow?: { start: Date; end: Date } | null;
}): DayInsightResult {
  const { date, tz, now, pending, rejected = [], window: frame, shift = null } = input;
  const calendarDay = input.calendarDay ?? frame;
  const nowMs = now.getTime();
  const calStart = calendarDay.start.getTime();
  const calEnd = calendarDay.end.getTime();
  const isToday = calStart <= nowMs && nowMs < calEnd;
  const isFuture = nowMs < calStart;

  // 1. One owner per minute — the shared resolution every screen reads.
  const pieces = input.timeline ?? resolveTimeline(
    (input.entries ?? []).map((e) => ({ ...e, userId: DAY_USER })),
    {
      now,
      trustOpenSegments: true,
      invalidations: (input.invalidations ?? []).map((iv) => ({ userId: DAY_USER, ...iv })),
    },
  );
  const solids: DayBlock[] = [];
  for (const p of pieces) {
    if (p.end <= calStart || p.start >= calEnd) continue;
    const kind = blockKindOf(p.kind);
    const e = p.entry;
    const attendeeIds =
      (kind === 'MEETING' || kind === 'MANUAL') && e.attendeeIds && e.attendeeIds.length > 0
        ? e.attendeeIds
        : undefined;
    solids.push({
      kind,
      startedAt: p.start,
      endedAt: p.end,
      durationMs: p.end - p.start,
      timeEntryId: e.id,
      ...(e.requestId ? { requestId: e.requestId } : {}),
      larkTaskGuid: e.larkTaskGuid,
      notes: e.notes ?? null,
      isOpen: p.live && isToday,
      ...(attendeeIds ? { attendeeIds } : {}),
      ...(p.invalidated ? { invalidated: true } : {}),
    });
  }
  solids.sort((x, y) => x.startedAt - y.startedAt);

  const pendingIv: PendingIv[] = pending
    .map((p) => ({
      id: p.id,
      a: p.requestedStart.getTime(),
      b: p.requestedEnd.getTime(),
      reason: p.reason,
      larkTaskGuid: p.larkTaskGuid,
      taskSummary: p.taskSummary ?? null,
      ...(p.attendeeIds && p.attendeeIds.length > 0 ? { attendeeIds: p.attendeeIds } : {}),
    }))
    .filter((p) => p.b > p.a)
    .sort((x, y) => x.a - y.a);

  // 2. Effective frame = shift bounds, EXPANDED to include any real activity
  //    that fell outside the shift (never hide tracked/pending time), then
  //    clamped to the calendar day.
  let winStart = frame.start.getTime();
  let winEnd = frame.end.getTime();
  for (const s of solids) {
    winStart = Math.min(winStart, s.startedAt);
    winEnd = Math.max(winEnd, s.endedAt);
  }
  for (const p of pendingIv) {
    if (p.b <= calStart || p.a >= calEnd) continue;
    winStart = Math.min(winStart, p.a);
    winEnd = Math.max(winEnd, p.b);
  }
  winStart = Math.max(winStart, calStart);
  winEnd = Math.min(winEnd, calEnd);
  const dayStart = winStart;
  const dayEnd = winEnd;
  // Gaps fill only up to `now` for today — never fabricate future idle.
  const gapCap = isToday ? Math.min(nowMs, dayEnd) : dayEnd;

  // 3. Clip solids to the frame.
  const clippedSolids: DayBlock[] = [];
  for (const s of solids) {
    const c = clipInterval({ start: s.startedAt, end: s.endedAt }, dayStart, dayEnd);
    if (!c) continue;
    clippedSolids.push({ ...s, startedAt: c.start, endedAt: c.end, durationMs: c.end - c.start });
  }

  // Activity envelope: counted time only, and a stretch that started before
  // midnight is a continuation, not this day's first activity.
  const counted = mergeIntervals(pieces.filter(isCounted));
  const firstActivityAt = firstStretchStartWithin(counted, calStart, calEnd);
  let lastEnd: number | null = null;
  for (const iv of counted) {
    const c = clipInterval(iv, dayStart, dayEnd);
    if (c && (lastEnd === null || c.end > lastEnd)) lastEnd = c.end;
  }
  const lastActivityAt = lastEnd === null ? null : isToday ? Math.max(lastEnd, nowMs) : lastEnd;

  // 4. Single partition: tracked and manual time are authoritative; PENDING is
  //    carved the way approval will carve it (over gaps and trimmed idle);
  //    everything else is GAP. Future days have no rows at all.
  const blocks: DayBlock[] = [];
  if (!isFuture) {
    const occupied = clippedSolids
      .filter((b) => b.kind !== 'IDLE_TRIMMED')
      .map((b) => ({ start: b.startedAt, end: b.endedAt }));
    const pendingBlocks = carvePending(pendingIv, occupied, dayStart, gapCap);
    const pendingIvs = pendingBlocks.map((b) => ({ start: b.startedAt, end: b.endedAt }));
    for (const b of clippedSolids) {
      if (b.kind !== 'IDLE_TRIMMED') {
        blocks.push(b);
        continue;
      }
      for (const part of subtractIntervals([{ start: b.startedAt, end: b.endedAt }], pendingIvs)) {
        blocks.push({ ...b, startedAt: part.start, endedAt: part.end, durationMs: part.end - part.start });
      }
    }
    blocks.push(...pendingBlocks);
    const filled = blocks.map((b) => ({ start: b.startedAt, end: b.endedAt }));
    for (const gap of subtractIntervals([{ start: dayStart, end: gapCap }], filled)) {
      blocks.push({ kind: 'GAP', startedAt: gap.start, endedAt: gap.end, durationMs: gap.end - gap.start });
    }
    blocks.sort((x, y) => x.startedAt - y.startedAt || x.endedAt - y.endedAt);
  }

  // 5. Totals (partition sums to the framed, capped day).
  const totals = {
    workedMs: 0,
    meetingMs: 0,
    manualMs: 0,
    idleTrimmedMs: 0,
    pendingMs: 0,
    gapMs: 0,
    invalidatedMs: 0,
  };
  for (const b of blocks) {
    if (b.invalidated && (b.kind === 'WORK' || b.kind === 'MEETING' || b.kind === 'MANUAL')) {
      totals.invalidatedMs += b.durationMs;
    } else if (b.kind === 'WORK') totals.workedMs += b.durationMs;
    else if (b.kind === 'MEETING') totals.meetingMs += b.durationMs;
    else if (b.kind === 'MANUAL') totals.manualMs += b.durationMs;
    else if (b.kind === 'IDLE_TRIMMED') totals.idleTrimmedMs += b.durationMs;
    else if (b.kind === 'PENDING') totals.pendingMs += b.durationMs;
    else if (b.kind === 'GAP') totals.gapMs += b.durationMs;
  }

  const recentRejected = rejected
    .map((r) => {
      const c = clipInterval({ start: r.requestedStart.getTime(), end: r.requestedEnd.getTime() }, dayStart, dayEnd);
      if (!c) return null;
      return {
        id: r.id,
        requestedStart: c.start,
        requestedEnd: c.end,
        reason: r.reason,
        decidedReason: r.decidedReason,
        larkTaskGuid: r.larkTaskGuid,
        taskSummary: r.taskSummary ?? null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.requestedStart - b.requestedStart);

  // Totals were summed from the raw partition above (exact); collapse the
  // blocks into a clean display list for the timeline + timesheet.
  const displayBlocks = coalesceForDisplay(blocks, COALESCE_MIN_MS);

  return {
    date,
    timezone: tz,
    calendarDayStart: calStart,
    calendarDayEnd: calEnd,
    dayStart,
    dayEnd,
    isFuture,
    isToday,
    shift: shift
      ? {
          ...shift,
          startedAt: (input.shiftWindow ?? frame).start.getTime(),
          endedAt: (input.shiftWindow ?? frame).end.getTime(),
        }
      : null,
    firstActivityAt,
    lastActivityAt,
    totals,
    blocks: displayBlocks,
    recentRejected,
  };
}
