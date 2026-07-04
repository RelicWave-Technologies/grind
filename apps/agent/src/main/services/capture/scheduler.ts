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
