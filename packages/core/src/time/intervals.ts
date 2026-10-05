/**
 * Half-open epoch-millisecond intervals, `[start, end)`.
 *
 * Every time surface reduces to a handful of operations on these — merge,
 * union, subtract, clip — and each surface used to carry its own copy. The
 * copies disagreed at the edges (touching vs overlapping, empty spans, open
 * ends), which is exactly where the totals on two screens drifted apart. This
 * is the one copy.
 *
 * Conventions, applied everywhere:
 *  - An interval with `end <= start` is empty and is dropped.
 *  - Touching intervals (`a.end === b.start`) merge.
 *  - Outputs are sorted by start and never overlap.
 *  - Inputs are never mutated.
 */

export interface Interval {
  start: number;
  end: number;
}

/** True when `[start, end)` has positive length. */
export function isNonEmpty(iv: Interval): boolean {
  return iv.end > iv.start;
}

/** Sorted, non-overlapping union of `intervals` (touching ones join). */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter(isNonEmpty)
    .map((iv) => ({ start: iv.start, end: iv.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push(iv);
  }
  return out;
}

/** Total covered time, counting each instant once however many spans cover it. */
export function unionMs(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, iv) => sum + (iv.end - iv.start), 0);
}

/** Plain sum of lengths — only correct for intervals already known disjoint. */
export function sumMs(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, iv) => sum + Math.max(0, iv.end - iv.start), 0);
}

/** `[start, end)` intersected with `[lo, hi)`, or null when they do not meet. */
export function clipInterval(iv: Interval, lo: number, hi: number): Interval | null {
  const start = Math.max(iv.start, lo);
  const end = Math.min(iv.end, hi);
  return end > start ? { start, end } : null;
}

/** Every interval clipped to `[lo, hi)`, empties dropped. */
export function clipIntervals(intervals: readonly Interval[], lo: number, hi: number): Interval[] {
  const out: Interval[] = [];
  for (const iv of intervals) {
    const c = clipInterval(iv, lo, hi);
    if (c) out.push(c);
  }
  return out;
}

/** Do `[aStart, aEnd)` and `[bStart, bEnd)` share any instant? */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Length of the overlap between two intervals. */
export function overlapMs(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * The parts of `base` not covered by `minus`. Both may be unsorted and
 * overlapping; the result is merged and sorted.
 */
export function subtractIntervals(base: readonly Interval[], minus: readonly Interval[]): Interval[] {
  const holes = mergeIntervals(minus);
  const out: Interval[] = [];
  for (const iv of mergeIntervals(base)) {
    let cursor = iv.start;
    for (const h of holes) {
      if (h.end <= cursor) continue;
      if (h.start >= iv.end) break;
      if (h.start > cursor) out.push({ start: cursor, end: Math.min(h.start, iv.end) });
      cursor = Math.max(cursor, h.end);
      if (cursor >= iv.end) break;
    }
    if (cursor < iv.end) out.push({ start: cursor, end: iv.end });
  }
  return out.filter(isNonEmpty);
}

/** The parts of `a` also covered by `b`, merged and sorted. */
export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i]!.start, right[j]!.start);
    const end = Math.min(left[i]!.end, right[j]!.end);
    if (end > start) out.push({ start, end });
    if (left[i]!.end < right[j]!.end) i += 1;
    else j += 1;
  }
  return out;
}

/** Is `t` inside any of `merged` (sorted, disjoint)? Half-open: the end is outside. */
export function containsInstant(merged: readonly Interval[], t: number): boolean {
  let lo = 0;
  let hi = merged.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const iv = merged[mid]!;
    if (t < iv.start) hi = mid - 1;
    else if (t >= iv.end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * The stretches of `[start, end)` no `occupied` interval covers. Used at write
 * time: a manual-time request is stored as only the minutes that are free.
 */
export function freeSlices(window: Interval, occupied: readonly Interval[]): Interval[] {
  if (!isNonEmpty(window)) return [];
  return subtractIntervals([window], occupied);
}

/**
 * Cut overlapping items down to a non-overlapping set, highest priority first.
 *
 * An item entirely covered by higher-priority time disappears; one partly
 * covered survives as its free parts. Equal priority resolves by earlier start,
 * then longer first, so the result does not depend on input order. Output is
 * sorted by start; items keep every field except their bounds.
 */
export function resolveByPriority<T extends Interval>(
  items: readonly T[],
  priorityOf: (item: T) => number,
): T[] {
  const order = [...items]
    .filter(isNonEmpty)
    .sort((a, b) =>
      priorityOf(b) - priorityOf(a)
      || a.start - b.start
      || b.end - a.end);

  const out: T[] = [];
  let claimed: Interval[] = [];
  for (const item of order) {
    for (const piece of subtractIntervals([item], claimed)) {
      out.push({ ...item, start: piece.start, end: piece.end });
    }
    claimed = mergeIntervals([...claimed, item]);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Split each item at every boundary of `cuts`, tagging the pieces that fall
 * inside a cut. Pieces keep every other field of their item.
 */
export function splitByIntervals<T extends Interval>(
  items: readonly T[],
  cuts: readonly Interval[],
): Array<{ item: T; start: number; end: number; inside: boolean }> {
  const holes = mergeIntervals(cuts);
  const out: Array<{ item: T; start: number; end: number; inside: boolean }> = [];
  for (const item of items) {
    if (!isNonEmpty(item)) continue;
    let cursor = item.start;
    for (const h of holes) {
      if (h.end <= cursor) continue;
      if (h.start >= item.end) break;
      if (h.start > cursor) out.push({ item, start: cursor, end: h.start, inside: false });
      const end = Math.min(h.end, item.end);
      out.push({ item, start: Math.max(cursor, h.start), end, inside: true });
      cursor = end;
      if (cursor >= item.end) break;
    }
    if (cursor < item.end) out.push({ item, start: cursor, end: item.end, inside: false });
  }
  return out;
}
