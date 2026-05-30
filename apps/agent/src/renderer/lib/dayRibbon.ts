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
    const gapStart = hit.startedAt;
    const gapEndCapped = Math.min(hit.endedAt, now); // can't extend a gap into the future
    const usableLen = gapEndCapped - gapStart;
    if (usableLen <= 4 * HOUR_MS) {
      startedAt = snapToGrid(gapStart);
      endedAt = snapToGrid(gapEndCapped);
    } else {
      // 1h window centered on the click, clamped to the gap.
      const half = 30 * 60 * 1000;
      startedAt = clamp(snappedClick - half, gapStart, gapEndCapped - HOUR_MS);
      endedAt = startedAt + HOUR_MS;
    }
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
 * Auto-zoom: span = max(12h, [first, last] padded by 15 min on each side),
 * capped at 24h. For an empty day, return [9am, 9pm] of the local day so the
 * UI still has something to show + click into.
 */
export function windowFor(args: {
  dayStart: number;
  dayEnd: number;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
}): { winStart: number; winEnd: number } {
  const { dayStart, dayEnd, firstActivityAt, lastActivityAt } = args;
  if (firstActivityAt === null || lastActivityAt === null) {
    // 9am – 9pm window (12h, fully within the day).
    const ws = dayStart + 9 * HOUR_MS;
    const we = ws + 12 * HOUR_MS;
    return { winStart: clamp(ws, dayStart, dayEnd - HOUR_MS), winEnd: clamp(we, dayStart + HOUR_MS, dayEnd) };
  }
  const pad = 15 * 60 * 1000;
  let winStart = firstActivityAt - pad;
  let winEnd = lastActivityAt + pad;
  let span = winEnd - winStart;
  if (span < MIN_RIBBON_SPAN_MS) {
    const need = MIN_RIBBON_SPAN_MS - span;
    winStart -= need / 2;
    winEnd += need / 2;
    span = winEnd - winStart;
  }
  if (span > MAX_RIBBON_SPAN_MS) {
    winStart = dayStart;
    winEnd = dayEnd;
  }
  // Clamp to day, but preserve 12h span if possible by shifting.
  if (winStart < dayStart) {
    winEnd += dayStart - winStart;
    winStart = dayStart;
  }
  if (winEnd > dayEnd) {
    winStart -= winEnd - dayEnd;
    winEnd = dayEnd;
  }
  winStart = Math.max(winStart, dayStart);
  winEnd = Math.min(winEnd, dayEnd);
  return { winStart, winEnd };
}

function clamp(x: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, x));
}
