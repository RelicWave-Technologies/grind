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
 * No prisma/network calls in this file. The route owns I/O; this owns logic.
 */

import {
  WEEKDAYS,
  hhmmToMin,
  instantForZonedDateTime,
  localDayWindowInTimeZone,
  type ShiftSchedule,
} from '@grind/types';

export type SegmentKind = 'WORK' | 'MEETING' | 'IDLE_TRIMMED';
/**
 * Every minute of the day belongs to exactly ONE block kind — the timeline is a
 * single partition (Time-Doctor style), no overlapping layers. PENDING requests
 * are carved out of the gaps they sit in, so a pending slot is never *also* a
 * gap row (that was the old "duplicacy").
 */
export type BlockKind = SegmentKind | 'MANUAL' | 'PENDING' | 'GAP';

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

export interface DayBlock {
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
  totals: { workedMs: number; meetingMs: number; manualMs: number; idleTrimmedMs: number; pendingMs: number; gapMs: number };
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

/**
 * The shift-bounded window for `date` in `tz`, or `null` to fall back to the
 * full calendar day (no shift, or a day off in the schedule). The schedule
 * forbids overnight shifts (`end > start`), so the window stays within the day.
 * DST-correct via the same solver as {@link localDayWindow}.
 */
export function shiftDayWindow(
  date: string,
  tz: string,
  schedule: ShiftSchedule,
): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  // Weekday of the *calendar* date (date string is already user-local), derived
  // tz-independently so it can't drift near midnight.
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  const day = schedule[weekday];
  if (!day) return null; // day off → caller uses the full calendar day
  const startMin = hhmmToMin(day.start);
  const endMin = hhmmToMin(day.end);
  try {
    return {
      start: utcInstantForLocalTime(y, m, d, startMin, tz),
      end: utcInstantForLocalTime(y, m, d, endMin, tz),
    };
  } catch {
    return null;
  }
}

/**
 * Delegate all wall-clock resolution to the shared timezone boundary. This
 * rejects impossible DST times and documents the deterministic fall-back rule.
 */
function utcInstantForLocalTime(
  year: number,
  month: number,
  day: number,
  minutesOfDay: number,
  tz: string,
): Date {
  return instantForZonedDateTime({
    year,
    month,
    day,
    hour: Math.floor(minutesOfDay / 60),
    minute: minutesOfDay % 60,
    second: 0,
  }, tz);
}

/** Clip [a,b) by [lo,hi) → returns null when disjoint. */
function clip(a: number, b: number, lo: number, hi: number): { a: number; b: number } | null {
  const start = Math.max(a, lo);
  const end = Math.min(b, hi);
  return end > start ? { a: start, b: end } : null;
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
 * Complement of sorted, non-overlapping `solids` over [lo, hi) — i.e. the empty
 * stretches. Robust to solids that touch, overlap, or spill past the bounds.
 */
function emptyStretches(solids: DayBlock[], lo: number, hi: number): Array<{ a: number; b: number }> {
  const out: Array<{ a: number; b: number }> = [];
  let cursor = lo;
  for (const s of solids) {
    if (s.startedAt > cursor) out.push({ a: cursor, b: Math.min(s.startedAt, hi) });
    cursor = Math.max(cursor, s.endedAt);
    if (cursor >= hi) break;
  }
  if (cursor < hi) out.push({ a: cursor, b: hi });
  return out.filter((x) => x.b > x.a);
}

/**
 * Fill one empty stretch [lo, hi) with GAP blocks, carving any PENDING requests
 * out of it as their own blocks. Pending is clipped to the stretch and
 * de-overlapped (a monotonic cursor), so the output is always a clean,
 * non-overlapping GAP/PENDING/GAP… sequence — even with messy/overlapping
 * requests. This is what makes pending and gap mutually exclusive (no duplicacy).
 */
function carveGap(lo: number, hi: number, pendingIv: PendingIv[], out: DayBlock[]): void {
  let cursor = lo;
  for (const p of pendingIv) {
    const a = Math.max(p.a, cursor);
    const b = Math.min(p.b, hi);
    if (b <= a) continue; // disjoint with this stretch, or already consumed
    if (a > cursor) out.push({ kind: 'GAP', startedAt: cursor, endedAt: a, durationMs: a - cursor });
    out.push({
      kind: 'PENDING',
      startedAt: a,
      endedAt: b,
      durationMs: b - a,
      requestId: p.id,
      reason: p.reason,
      larkTaskGuid: p.larkTaskGuid,
      taskSummary: p.taskSummary ?? null,
      ...(p.attendeeIds ? { attendeeIds: p.attendeeIds } : {}),
    });
    cursor = b;
  }
  if (cursor < hi) out.push({ kind: 'GAP', startedAt: cursor, endedAt: hi, durationMs: hi - cursor });
}

/** Sub-`COALESCE_MIN_MS` idle/gaps fold INTO the surrounding work; adjacent
 *  same-kind + same-task work merges into one continuous block. Time-Doctor
 *  style — totals are computed from the raw partition BEFORE this, so folding a
 *  short idle into work never changes the hour counts. */
export const COALESCE_MIN_MS = 120_000; // 2 minutes

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
export function coalesceForDisplay(blocks: DayBlock[], minMs: number): DayBlock[] {
  const out: DayBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    if (isFiller(b.kind)) {
      const prev = out[out.length - 1];
      if (b.durationMs < minMs && prev && isTracked(prev.kind)) {
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

/**
 * Main composer — builds the single, contiguous, non-overlapping day partition.
 * `now` lets tests be deterministic. `frame` is the shift window (or full day);
 * `calendarDay` is the true midnight→midnight span (drives isToday/isFuture and
 * caps the frame so it can never exceed the calendar day).
 */
export function buildDayInsight(input: {
  date: string;
  tz: string;
  now: Date;
  entries: DayEntryInput[];
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
  const { date, tz, now, entries, pending, rejected = [], window: frame, shift = null } = input;
  const calendarDay = input.calendarDay ?? frame;
  const nowMs = now.getTime();
  const calStart = calendarDay.start.getTime();
  const calEnd = calendarDay.end.getTime();
  const isToday = calStart <= nowMs && nowMs < calEnd;
  const isFuture = nowMs < calStart;

  // 1. Flatten + tag real ("solid") blocks. Not clipped yet — we need true
  //    extents to expand the frame so off-shift work is never hidden.
  const solids: DayBlock[] = [];
  for (const e of entries) {
    for (const s of e.segments) {
      const a = s.startedAt.getTime();
      const b = s.endedAt ? s.endedAt.getTime() : nowMs; // open running → now
      if (b <= a) continue;
      const kind: BlockKind = e.source === 'MANUAL' ? 'MANUAL' : s.kind;
      const attendeeIds =
        (kind === 'MEETING' || kind === 'MANUAL') && e.attendeeIds && e.attendeeIds.length > 0
          ? e.attendeeIds
          : undefined;
      solids.push({
        kind,
        startedAt: a,
        endedAt: b,
        durationMs: b - a,
        timeEntryId: e.id,
        ...(e.requestId ? { requestId: e.requestId } : {}),
        larkTaskGuid: e.larkTaskGuid,
        notes: e.notes ?? null,
        isOpen: s.endedAt === null && isToday,
        ...(attendeeIds ? { attendeeIds } : {}),
      });
    }
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
    const c = clip(s.startedAt, s.endedAt, dayStart, dayEnd);
    if (!c) continue;
    clippedSolids.push({ ...s, startedAt: c.a, endedAt: c.b, durationMs: c.b - c.a });
  }

  // Activity envelope (real blocks only).
  const firstActivityAt = clippedSolids.length ? clippedSolids[0]!.startedAt : null;
  let lastActivityAt: number | null = null;
  if (clippedSolids.length) {
    const lastEnd = clippedSolids[clippedSolids.length - 1]!.endedAt;
    lastActivityAt = isToday ? Math.max(lastEnd, nowMs) : lastEnd;
  }

  // 4. Single partition: solids are authoritative; carve PENDING out of the
  //    empty stretches between them; everything else is GAP. Future days have
  //    no rows at all.
  const blocks: DayBlock[] = [];
  if (!isFuture) {
    const carved: DayBlock[] = [];
    for (const stretch of emptyStretches(clippedSolids, dayStart, gapCap)) {
      carveGap(stretch.a, stretch.b, pendingIv, carved);
    }
    blocks.push(...clippedSolids, ...carved);
    blocks.sort((x, y) => x.startedAt - y.startedAt);
  }

  // 5. Totals (partition sums to the framed, capped day).
  const totals = { workedMs: 0, meetingMs: 0, manualMs: 0, idleTrimmedMs: 0, pendingMs: 0, gapMs: 0 };
  for (const b of blocks) {
    if (b.kind === 'WORK') totals.workedMs += b.durationMs;
    else if (b.kind === 'MEETING') totals.meetingMs += b.durationMs;
    else if (b.kind === 'MANUAL') totals.manualMs += b.durationMs;
    else if (b.kind === 'IDLE_TRIMMED') totals.idleTrimmedMs += b.durationMs;
    else if (b.kind === 'PENDING') totals.pendingMs += b.durationMs;
    else if (b.kind === 'GAP') totals.gapMs += b.durationMs;
  }

  const recentRejected = rejected
    .map((r) => {
      const c = clip(r.requestedStart.getTime(), r.requestedEnd.getTime(), dayStart, dayEnd);
      if (!c) return null;
      return {
        id: r.id,
        requestedStart: c.a,
        requestedEnd: c.b,
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
