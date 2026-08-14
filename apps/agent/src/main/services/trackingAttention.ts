import { ulid } from 'ulid';
import type { AttentionPrompt, PermissionIntent } from '../../shared/attention';
import { attentionHost, type OverlayHost, type PlacementSpec } from '../attentionWindow';
import { holdPrompt } from '../windows/overlay';

/**
 * The single owner of "which prompt is the user being asked to answer, and is
 * it still on top".
 *
 * WHY THIS HOLDS RATHER THAN RE-RAISES
 *
 * Keeping a prompt on top used to be attempted by a fixed ladder of timed
 * re-raises (100/400/1000ms) plus six external trigger sites — wake, unlock and
 * three display events. None of them looked at the outcome, so after the last
 * rung nothing enforced anything and the prompt stayed wherever it had landed.
 * Users saw it surface two to five times and then sit behind other windows for
 * the rest of the session.
 *
 * The set of events that can bury a window is open-ended and cannot be
 * enumerated. "Am I on top?" can be checked at any moment. So this holds a
 * predicate instead of firing commands: while a prompt is front, a low-frequency
 * loop asks the host and re-raises ONLY on an observed loss. Adding a new way
 * for a window to get buried no longer requires adding a new trigger.
 */

const HOLD_INTERVAL_MS = 1_000;
// While suspended the resume predicate can hit the permission probe, so check it
// less often than the on-top check.
const RESUME_CHECK_EVERY_TICKS = 2;

const SIZES = {
  IDLE_WARNING: { width: 340, height: 280 },
  IDLE: { width: 340, height: 280 },
  AWAY: { width: 360, height: 222 },
  PERMISSION: { width: 480, height: 332 },
} as const;

type ActivePrompt = Exclude<AttentionPrompt, { kind: 'NONE' }>;

/** Returns true once the reason for suspending has passed. May be async. */
export type ResumeWhen = () => boolean | Promise<boolean>;

export interface TrackingAttentionDeps {
  id: () => string;
  host: OverlayHost;
  /** Signals ambient overlays to stand down while a prompt is held. */
  setPromptHeld?: (held: boolean) => void;
  holdIntervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

function specFor(prompt: ActivePrompt): PlacementSpec {
  return {
    ...SIZES[prompt.kind],
    placement: prompt.kind === 'AWAY' ? 'topRight' : 'center',
  };
}

export function createTrackingAttentionCoordinator(deps: TrackingAttentionDeps) {
  const holdIntervalMs = deps.holdIntervalMs ?? HOLD_INTERVAL_MS;
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;
  const setPromptHeld = deps.setPromptHeld ?? holdPrompt;

  let active: AttentionPrompt = { kind: 'NONE' };
  let holdTimer: ReturnType<typeof setInterval> | null = null;
  let resumeWhen: ResumeWhen | null = null;
  let resumeCheckInFlight = false;
  let ticks = 0;
  let readyHooked = false;

  /** A prompt that should currently be sitting on top of everything. */
  function isFront(prompt: AttentionPrompt): boolean {
    return prompt.kind !== 'NONE'
      && (prompt.kind !== 'PERMISSION' || prompt.presentation === 'FRONT');
  }

  function hookReadyOnce(): void {
    if (readyHooked) return;
    readyHooked = true;
    // The renderer may not have loaded when the first prompt is requested; the
    // surface has to be re-presented once it has, or it shows empty.
    deps.host.onReady(() => {
      if (active.kind === 'NONE') return;
      deps.host.publish(active);
      if (isFront(active)) presentNow();
    });
  }

  /** Place once, raise once. The hold loop takes it from here. */
  function presentNow(): void {
    if (!isFront(active)) return;
    deps.host.place(specFor(active as ActivePrompt));
    deps.host.raise();
    startHold();
  }

  function tick(): void {
    if (active.kind === 'NONE') {
      stopHold();
      return;
    }
    if (!isFront(active)) {
      checkResume();
      return;
    }
    // The whole point: look before acting. A prompt that is still on top costs
    // two boolean reads and no window churn.
    if (deps.host.onTop()) return;
    deps.host.raise();
  }

  function checkResume(): void {
    ticks += 1;
    if (!resumeWhen || resumeCheckInFlight || ticks % RESUME_CHECK_EVERY_TICKS !== 0) return;
    const predicate = resumeWhen;
    resumeCheckInFlight = true;
    void Promise.resolve()
      .then(predicate)
      .then((done) => {
        if (done && resumeWhen === predicate) restoreActive();
      })
      .catch(() => {
        // A failing predicate must not wedge the prompt in a suspended state
        // forever; the next tick simply tries again.
      })
      .finally(() => {
        resumeCheckInFlight = false;
      });
  }

  function startHold(): void {
    setPromptHeld(true);
    if (holdTimer) return;
    holdTimer = setIntervalFn(tick, holdIntervalMs);
    holdTimer.unref?.();
  }

  function stopHold(): void {
    setPromptHeld(false);
    if (!holdTimer) return;
    clearIntervalFn(holdTimer);
    holdTimer = null;
  }

  function show(next: ActivePrompt): AttentionPrompt {
    active = next;
    resumeWhen = null;
    hookReadyOnce();
    deps.host.publish(active);
    presentNow();
    return active;
  }

  function requestIdle(idleStartedAt: number): boolean {
    if (active.kind === 'IDLE_WARNING') {
      show({ kind: 'IDLE', promptId: active.promptId, idleStartedAt });
      return true;
    }
    if (active.kind !== 'NONE') return false;
    show({ kind: 'IDLE', promptId: deps.id(), idleStartedAt });
    return true;
  }

  function requestIdleWarning(info: { idleStartedAt: number; deadlineAt: number }): boolean {
    if (active.kind !== 'NONE') return false;
    show({ kind: 'IDLE_WARNING', promptId: deps.id(), ...info });
    return true;
  }

  function clearIdleWarning(): boolean {
    if (active.kind !== 'IDLE_WARNING') return false;
    return clear(active.promptId);
  }

  function beginMachineAway(): void {
    if (active.kind === 'IDLE_WARNING' || active.kind === 'IDLE' || active.kind === 'AWAY') {
      active = { kind: 'NONE' };
      resumeWhen = null;
      stopHold();
      deps.host.hide();
    }
  }

  function requestAway(info: { larkTaskGuid: string | null; stoppedAt: number; reason: 'suspend' | 'lock' }): boolean {
    if (active.kind === 'PERMISSION') return false;
    show({ kind: 'AWAY', promptId: deps.id(), ...info });
    return true;
  }

  function requestPermission(intent: PermissionIntent): AttentionPrompt {
    const promptId = active.kind === 'PERMISSION' ? active.promptId : deps.id();
    return show({ kind: 'PERMISSION', promptId, intent, presentation: 'FRONT' });
  }

  /**
   * The user has gone to System Settings. Stand down so we are not sitting on
   * top of the window they need — but keep holding the prompt in a suspended
   * state, and come back by ourselves once `resumeWhen` says the reason has
   * passed. Without a predicate this used to be a one-way trip: granting the
   * permission left the prompt stranded behind Settings until the user happened
   * to click the tray.
   */
  function yieldPermissionToSystemSettings(promptId: string, opts: { resumeWhen?: ResumeWhen } = {}): boolean {
    if (active.kind !== 'PERMISSION' || active.promptId !== promptId) return false;
    active = { ...active, presentation: 'YIELDED_TO_SETTINGS' };
    resumeWhen = opts.resumeWhen ?? null;
    ticks = 0;
    deps.host.publish(active);
    deps.host.lower();
    // Ambient overlays may float normally again while we are deliberately down.
    setPromptHeld(false);
    return true;
  }

  function restoreActive(): boolean {
    if (active.kind === 'NONE') return false;
    if (active.kind === 'PERMISSION' && active.presentation === 'YIELDED_TO_SETTINGS') {
      active = { ...active, presentation: 'FRONT' };
      resumeWhen = null;
      deps.host.publish(active);
    }
    presentNow();
    return true;
  }

  function clear(promptId?: string): boolean {
    if (active.kind === 'NONE') return false;
    if (promptId && active.promptId !== promptId) return false;
    active = { kind: 'NONE' };
    resumeWhen = null;
    stopHold();
    deps.host.publish(active);
    deps.host.hide();
    return true;
  }

  return {
    get: (): AttentionPrompt => active,
    requestIdleWarning,
    requestIdle,
    clearIdleWarning,
    beginMachineAway,
    requestAway,
    requestPermission,
    yieldPermissionToSystemSettings,
    restoreActive,
    clear,
    isPermissionActive: () => active.kind === 'PERMISSION',
    /** Test seam: run one hold tick without waiting on a real timer. */
    __holdTickForTests: tick,
  };
}

let singleton: ReturnType<typeof createTrackingAttentionCoordinator> | null = null;

export function getTrackingAttentionCoordinator() {
  if (!singleton) {
    singleton = createTrackingAttentionCoordinator({ id: ulid, host: attentionHost });
  }
  return singleton;
}
