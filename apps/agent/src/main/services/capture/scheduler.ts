/**
 * Pure screenshot scheduling logic (no Electron), so it's unit-testable.
 *
 * Screenshots are taken on the exact server-driven cadence. The product policy
 * only allows 1m, 2m, or 3m intervals; this helper still keeps a defensive
 * 1-second floor for tests/dev overrides.
 */

/** Next capture delay in ms, exact with a defensive 1s floor. */
export function nextDelayMs(intervalMs: number): number {
  return Math.max(1000, Math.round(intervalMs));
}

/**
 * Whether to hold a capture back because the person is mid-interaction.
 *
 * `desktopCapturer.getSources` costs ~290ms on the process that owns every
 * window, so a capture stutters the timer bar, any open prompt and the main
 * window together. Measured on a real machine: ~440ms end to end, every time.
 *
 * A stall nobody is present for costs nothing, so the shot waits for a gap in
 * input. The wait is bounded: someone typing continuously would otherwise never
 * be captured, which would be a worse bug than a brief stutter.
 *
 * @param idleSeconds   seconds since the last input (powerMonitor).
 * @param deferrals     how many times this capture has already been held back.
 */
export function shouldDeferCapture(idleSeconds: number, deferrals: number): boolean {
  if (deferrals >= MAX_CAPTURE_DEFERRALS) return false;
  return idleSeconds < CAPTURE_QUIET_SECONDS;
}

/** Input must have been quiet this long for a capture to go ahead. */
export const CAPTURE_QUIET_SECONDS = 2;
/** Never hold a capture back longer than this many attempts. */
export const MAX_CAPTURE_DEFERRALS = 3;
/** How long to wait before re-checking for a gap in input. */
export const CAPTURE_DEFER_MS = 2_000;
