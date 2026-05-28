/**
 * Pure idle-decision helpers (no Electron), so the behavior is unit-testable.
 *
 * The OS idle timer (`powerMonitor.getSystemIdleTime`) reports seconds since the
 * last keyboard/mouse input. We prompt "are you still working?" once that
 * crosses the threshold while a timer is running and no prompt is already open.
 */

export interface IdleInputs {
  isRunning: boolean;
  /** seconds since last input (from the OS) */
  idleSeconds: number;
  /** threshold in seconds before we prompt */
  thresholdSec: number;
  /** a prompt is already showing */
  prompting: boolean;
}

export function shouldPromptIdle(i: IdleInputs): boolean {
  return i.isRunning && !i.prompting && i.idleSeconds >= i.thresholdSec;
}

/** The real moment the user went idle = now minus the OS idle duration. */
export function computeIdleStart(nowMs: number, idleSeconds: number): number {
  return nowMs - Math.max(0, idleSeconds) * 1000;
}
