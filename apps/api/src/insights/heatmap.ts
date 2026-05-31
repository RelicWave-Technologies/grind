import { scoreMinute, isIdleMinute, type MinuteActivity, type MinuteContext } from '../scoring/score';
import type { RoleTitle } from '../scoring/presets';

/**
 * Per-day activity heatmap: a fixed grid of equal-width buckets covering
 * the local-day window. Each bucket = average per-minute productivity score
 * across the samples that land in it. `null` means "no samples in this
 * bucket" — distinct from "samples scored 0" (e.g. fully idle) so the
 * dashboard can render dead air differently from idle time.
 */

export interface HeatmapSample extends MinuteActivity, MinuteContext {
  bucketStartMs: number;
}

export interface HeatmapResult {
  bucketMs: number;
  /** Length is always `(dayEnd - dayStart) / bucketMs` (= 144 for 10-min buckets on a 24h UTC day). */
  buckets: Array<number | null>;
  /** Length matches `buckets`. Useful when the dashboard wants to weight intensity by how many minutes contributed. */
  sampleCounts: number[];
}

export const DEFAULT_BUCKET_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Build the heatmap. Pure — no DB access. The route does the SQL +
 * passes samples and the local-day window in.
 *
 *   dayStart / dayEnd:  local-day window in epoch ms (DST-correct).
 *   samples:            ActivitySample-like rows for that user-day.
 *   role:               drives the scoring preset.
 *   bucketMs:           default 10 min; smaller buckets = sharper grid.
 */
export function buildHeatmap(input: {
  dayStart: number;
  dayEnd: number;
  samples: HeatmapSample[];
  role?: RoleTitle | null;
  bucketMs?: number;
}): HeatmapResult {
  const bucketMs = input.bucketMs ?? DEFAULT_BUCKET_MS;
  const span = input.dayEnd - input.dayStart;
  if (span <= 0 || bucketMs <= 0) {
    return { bucketMs, buckets: [], sampleCounts: [] };
  }
  // Round UP so a DST 23h day still produces a complete grid; the trailing
  // bucket will just be shorter and absorbed by the same key.
  const len = Math.ceil(span / bucketMs);
  const sums: number[] = new Array(len).fill(0);
  const counts: number[] = new Array(len).fill(0);

  for (const s of input.samples) {
    if (s.bucketStartMs < input.dayStart || s.bucketStartMs >= input.dayEnd) continue;
    const idx = Math.floor((s.bucketStartMs - input.dayStart) / bucketMs);
    if (idx < 0 || idx >= len) continue;
    // scoreMinute returns 0..1; we render as 0..100 in the dashboard.
    const score = scoreMinute(
      {
        keystrokes: s.keystrokes,
        clicks: s.clicks,
        scrollEvents: s.scrollEvents,
        mouseDistancePx: s.mouseDistancePx,
      },
      { role: input.role ?? null, ctx: { isProtectedMeeting: s.isProtectedMeeting } },
    );
    sums[idx]! += score;
    counts[idx]! += 1;
    // Suppress "unused" — isIdleMinute is exported as part of the scoring
    // contract; we don't re-derive idleness here, scoreMinute already encodes it.
    void isIdleMinute;
  }

  const buckets: Array<number | null> = new Array(len);
  for (let i = 0; i < len; i++) {
    if (counts[i] === 0) buckets[i] = null;
    else buckets[i] = Math.round((100 * sums[i]!) / counts[i]!);
  }
  return { bucketMs, buckets, sampleCounts: counts };
}
