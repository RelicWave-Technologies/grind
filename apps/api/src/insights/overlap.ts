/**
 * One timeline, one owner per minute.
 *
 * A day is a partition: every instant belongs to exactly one entry. Nothing
 * enforced that. An approved manual entry is a real TimeEntry with real
 * segments, so when a manual claim lands on top of tracked time both rows
 * survive and every consumer that sums durations counts those minutes twice —
 * the Edit Time totals, the timesheet cells, and through them payroll.
 *
 * The rule this module applies is the one the day view already states for
 * pending requests: **real time wins**. Tracked time is evidence — it has
 * screenshots and activity behind it. Manual time is a claim. Where they
 * disagree about a minute, the evidence keeps it and the claim is trimmed to
 * whatever is genuinely free.
 *
 * That also matches how the products this one is modelled on behave: Hubstaff
 * reassigns contested minutes to a single owner rather than counting them
 * twice, and Time Doctor discards the losing side outright when two sources
 * claim the same period.
 *
 * Pure, and shared, so the totals and the rows can never disagree again.
 */

export interface Span {
  startedAt: number;
  endedAt: number;
}

/**
 * Ranking for contested minutes. Higher wins.
 *
 * Tracked work and meetings sit together at the top: both are observed, and a
 * single agent cannot produce two at once, so they never actually contend.
 *
 * Manual sits below observed time but ABOVE trimmed idle. Idle is time the
 * agent decided was not work, and correcting a bad idle trim is the main thing
 * manual time is for — if idle outranked it, that correction could never be
 * made, and the claimed minutes would vanish instead of landing anywhere.
 */
export const CLAIM_PRIORITY = { tracked: 2, manual: 1, idle: 0 } as const;

/** Merge a sorted-by-start list of spans, joining touching or overlapping ones. */
function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.startedAt <= last.endedAt) last.endedAt = Math.max(last.endedAt, s.endedAt);
    else out.push({ startedAt: s.startedAt, endedAt: s.endedAt });
  }
  return out;
}

/** The parts of `span` not already covered by `claimed` (which must be merged). */
function subtract(span: Span, claimed: readonly Span[]): Span[] {
  const out: Span[] = [];
  let cursor = span.startedAt;
  for (const c of claimed) {
    if (c.endedAt <= cursor) continue;
    if (c.startedAt >= span.endedAt) break;
    if (c.startedAt > cursor) out.push({ startedAt: cursor, endedAt: Math.min(c.startedAt, span.endedAt) });
    cursor = Math.max(cursor, c.endedAt);
    if (cursor >= span.endedAt) break;
  }
  if (cursor < span.endedAt) out.push({ startedAt: cursor, endedAt: span.endedAt });
  return out.filter((s) => s.endedAt > s.startedAt);
}

/**
 * Cut overlapping items down to a non-overlapping set, highest priority first.
 *
 * An item that is entirely covered by higher-priority time disappears — that is
 * the point: those minutes are already counted, once, under their real owner.
 * An item that is partly covered survives as the free parts, so a manual entry
 * that spills past the end of a tracked stretch still contributes the spill.
 *
 * Equal priority resolves by start time, then by longer-first, so the result is
 * deterministic regardless of input order. Two tracked segments should never
 * contend in practice; if they somehow do, the earlier one keeps the minutes,
 * which is the same first-writer-wins rule the sync layer already applies.
 *
 * Output is sorted by start. Items are returned unchanged except for their
 * bounds, so callers keep their own ids, kinds and labels.
 */
export function resolveOverlaps<T extends Span>(
  items: readonly T[],
  priorityOf: (item: T) => number,
): T[] {
  const order = [...items].sort((a, b) =>
    priorityOf(b) - priorityOf(a)
    || a.startedAt - b.startedAt
    || b.endedAt - a.endedAt);

  const out: T[] = [];
  let claimed: Span[] = [];
  for (const item of order) {
    if (item.endedAt <= item.startedAt) continue;
    for (const piece of subtract(item, claimed)) {
      out.push({ ...item, startedAt: piece.startedAt, endedAt: piece.endedAt });
    }
    claimed = mergeSpans([...claimed, item]);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt);
}

/**
 * The parts of `[startedAt, endedAt)` that no existing span occupies.
 *
 * Used at write time: a manual-time request is stored as only the stretches
 * that are actually free, so the overlap never reaches the database and every
 * reader is correct without doing this work itself. An empty result means the
 * whole request is already accounted for.
 */
export function freeSlices(span: Span, occupied: readonly Span[]): Span[] {
  if (span.endedAt <= span.startedAt) return [];
  return subtract(span, mergeSpans(occupied.filter((s) => s.endedAt > s.startedAt)));
}

/** Total covered time, counting each instant once however many spans cover it. */
export function unionMs(spans: readonly Span[]): number {
  return mergeSpans(spans.filter((s) => s.endedAt > s.startedAt))
    .reduce((sum, s) => sum + (s.endedAt - s.startedAt), 0);
}
