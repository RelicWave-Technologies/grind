/**
 * Pure helpers for the "Edit Time" DayRibbon.
 *
 * - `snapToGrid` rounds an epoch-ms to the nearest 5-minute mark so the
 *   composer pre-fill is human-readable (no 9:13:47 AM start times).
 * - `findBlockAt` locates the block at a given moment.
 * - `presetForClick` converts a click on the ribbon into the (start, end,
 *   larkTaskGuid) we use to pre-fill ManualTimeComposer.
 * - `windowFor` computes the auto-zoom window (min 12h, expands to fit
 *   activity) so the ribbon spans a meaningful range.
 */

export type DayBlockClient = {
  kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED' | 'MANUAL' | 'GAP';
  startedAt: number;
  endedAt: number;
  durationMs: number;
  timeEntryId?: string;
  larkTaskGuid?: string | null;
  isOpen?: boolean;
};

export type PendingOverlay = { id: string; startedAt: number; endedAt: number; reason: string; larkTaskGuid: string | null };

const FIVE_MIN_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_RIBBON_SPAN_MS = 12 * HOUR_MS;
const MAX_RIBBON_SPAN_MS = 24 * HOUR_MS;

/** Round `ms` to the nearest 5-minute mark. */
export function snapToGrid(ms: number, stepMs = FIVE_MIN_MS): number {
  return Math.round(ms / stepMs) * stepMs;
}

/** First block whose [startedAt, endedAt) contains `t`. */
export function findBlockAt(blocks: DayBlockClient[], t: number): DayBlockClient | null {
  for (const b of blocks) {
    if (b.startedAt <= t && t < b.endedAt) return b;
  }
  return null;
}

/**
 * Convert a click time into a ManualTimeComposer preset.
 *
 * Rules:
 *  - If the click lands in a GAP block:
 *      - Gap ≤ 4h → snap preset to the full gap (the "forgot to start
 *        tracker" sweet spot).
 *      - Gap > 4h → 1h window centered on the click, clamped to the gap.
 *  - If the click lands outside any block → 1h window starting at the
 *    snapped click time, clamped to `[dayStart, dayEnd]` and `<= now`.
 *  - Clicks in WORK/MEETING/MANUAL/IDLE_TRIMMED blocks return `null` (no
 *    preset — the UI should show a popover with details instead).
 *  - End time is clipped to `now` so the user never submits a future range
 *    (the backend would reject anyway, but we want the form to be valid up
 *    front so "Send to approver" isn't disabled for no visible reason).
 *
 * `larkTaskGuid` heuristic: if a GAP is bordered on either side by a
 * non-MANUAL/non-GAP block that has a `larkTaskGuid`, and both neighbors
 * share the same guid, we pre-fill that as the task. If they disagree, we
 * leave it null (better to be cautious than guess wrong).
 */
export function presetForClick(args: {
  blocks: DayBlockClient[];
  clickedAtMs: number;
  dayStart: number;
  dayEnd: number;
  now: number;
}): { startedAt: number; endedAt: number; larkTaskGuid: string | null } | null {
  const { blocks, clickedAtMs, dayStart, dayEnd, now } = args;

  // Bail on future or pre-day clicks.
  if (clickedAtMs < dayStart || clickedAtMs >= dayEnd) return null;
  if (clickedAtMs > now) return null;

  const hit = findBlockAt(blocks, clickedAtMs);
  if (hit && hit.kind !== 'GAP') return null;

  const snappedClick = clamp(snapToGrid(clickedAtMs), dayStart, Math.min(dayEnd, now));

  let startedAt: number;
  let endedAt: number;
  let neighborGuid: string | null = null;

  if (hit && hit.kind === 'GAP') {
    // Always snap to the FULL gap (capped at `now` so we never request future
    // time). The previous "1h-window for >4h gaps" behaviour confused users —
    // they want one click to represent the whole untracked slot, then edit
    // the start/end down to the actual range before submitting.
    const gapStart = hit.startedAt;
    const gapEndCapped = Math.min(hit.endedAt, now);
    startedAt = snapToGrid(gapStart);
    endedAt = snapToGrid(gapEndCapped);
    neighborGuid = sharedNeighborGuid(blocks, hit);
  } else {
    // Click outside any rendered block (rare — happens before firstActivity).
    startedAt = clamp(snappedClick, dayStart, Math.min(dayEnd, now) - HOUR_MS);
    endedAt = startedAt + HOUR_MS;
  }

  // Final safety: end must always be > start, and not in the future.
  if (endedAt <= startedAt) return null;
  endedAt = Math.min(endedAt, now);
  if (endedAt - startedAt < 5 * 60 * 1000) return null; // <5min isn't worth requesting

  return { startedAt, endedAt, larkTaskGuid: neighborGuid };
}

/** Returns a guid only when both neighbors agree (or only one side exists and has one). */
function sharedNeighborGuid(blocks: DayBlockClient[], gap: DayBlockClient): string | null {
  const idx = blocks.indexOf(gap);
  if (idx < 0) return null;
  const left = idx > 0 ? blocks[idx - 1] : undefined;
  const right = idx < blocks.length - 1 ? blocks[idx + 1] : undefined;
  const guidOf = (b: DayBlockClient | undefined): string | null => {
    if (!b) return null;
    if (b.kind === 'GAP' || b.kind === 'MANUAL') return null;
    return b.larkTaskGuid ?? null;
  };
  const l = guidOf(left);
  const r = guidOf(right);
  if (l && r) return l === r ? l : null;
  return l ?? r ?? null;
}

/** Returns true when `ms` overlaps any PENDING overlay span. */
export function isInsidePendingOverlay(overlays: PendingOverlay[], ms: number): boolean {
  for (const o of overlays) {
    if (o.startedAt <= ms && ms < o.endedAt) return true;
  }
  return false;
}

/**
 * Always show the full 24-hour day (local midnight → next local midnight).
 *
 * This makes the ribbon a stable reference frame: a 9 AM tracked block
 * always sits at the "9 AM" tick on the axis, regardless of when the user
 * first started working. The table's gap rows + the ribbon now share the
 * same coordinate space, so a click at "8:30" on the ribbon lands on the
 * same instant as the "8:30" row in the table.
 *
 * Once the Shifts feature ships (admin-defined working windows per user),
 * the visible range can shrink to the shift bounds. Until then, full day.
 */
export function windowFor(args: {
  dayStart: number;
  dayEnd: number;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
}): { winStart: number; winEnd: number } {
  void args.firstActivityAt;
  void args.lastActivityAt;
  return { winStart: args.dayStart, winEnd: args.dayEnd };
}

function clamp(x: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, x));
}
