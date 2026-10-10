/**
 * Pure idle-decision helpers (no Electron), so the behavior is unit-testable.
 *
 * The OS idle timer (`powerMonitor.getSystemIdleTime`) reports seconds since the
 * last keyboard/mouse input.
 */

/** The real moment the user went idle = now minus the OS idle duration. */
export function computeIdleStart(nowMs: number, idleSeconds: number): number {
  return nowMs - Math.max(0, idleSeconds) * 1000;
}
