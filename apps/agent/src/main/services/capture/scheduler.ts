/**
 * Pure screenshot scheduling logic (no Electron), so it's unit-testable.
 *
 * Screenshots are taken on a jittered cadence so the timing is unpredictable
 * (users can't game it) but bounded: never sooner than half the interval, never
 * later than the full interval. With the default 3h interval that's one shot
 * every ~90–180 min.
 */

/** Next capture delay in ms, jittered within [interval/2, interval]. */
export function nextDelayMs(intervalMs: number, rng: () => number = Math.random): number {
  const safe = Math.max(1000, intervalMs);
  const half = safe / 2;
  const r = Math.min(1, Math.max(0, rng()));
  return Math.round(half + r * half);
}
