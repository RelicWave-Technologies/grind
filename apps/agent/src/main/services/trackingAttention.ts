import { ulid } from 'ulid';
import type { AttentionPrompt, PermissionIntent } from '../../shared/attention';
import { attentionHost, type OverlayHost, type PlacementSpec } from '../attentionWindow';
import { log } from '../logger';

/**
 * The single owner of "which prompt is the user being asked to answer".
 *
 * Staying on top is NOT this module's job — the overlay keeper does that for
 * every overlay, using the cadence the timer bar proved in the field. This
 * module decides which prompt wins, places it once, and tells the keeper to
 * hold it until it is answered.
 *
 * The only timer here runs while a prompt is suspended for System Settings, to
 * poll the resume predicate. It exists for at most as long as the user is in
 * Settings and stops the moment the prompt comes back.
 */

// Polling for "has the permission been granted yet" hits a real capability
// probe, so it is deliberately slower than the keeper's cadence.
const RESUME_POLL_MS = 2_000;

const SIZES = {
  IDLE_WARNING: { width: 340, height: 280 },
  IDLE: { width: 340, height: 280 },
  AWAY: { width: 360, height: 222 },
  PERMISSION: { width: 480, height: 332 },
} as const;

type ActivePrompt = Exclude<AttentionPrompt, { kind: 'NONE' }>;

/** Returns true once the reason for suspending has passed. May be async. */
export type ResumeWhen = () => boolean | Promise<boolean>;

/**
 * A Prompt used to leave no trace at all — `idle warning presented` was the only
 * prompt event the agent ever wrote, which is why a prompt that went up and
 * never came back was invisible in four days of field logs. Every transition
 * now says so.
 */
export interface TrackingAttentionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface TrackingAttentionDeps {
  id: () => string;
  host: OverlayHost;
  resumePollMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  logger?: TrackingAttentionLogger;
}

function specFor(prompt: ActivePrompt): PlacementSpec {
  return {
    ...SIZES[prompt.kind],
    placement: prompt.kind === 'AWAY' ? 'topRight' : 'center',
  };
}

export function createTrackingAttentionCoordinator(deps: TrackingAttentionDeps) {
  const resumePollMs = deps.resumePollMs ?? RESUME_POLL_MS;
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;

  let active: AttentionPrompt = { kind: 'NONE' };
  let resumeTimer: ReturnType<typeof setInterval> | null = null;
  let resumeWhen: ResumeWhen | null = null;
  let resumeCheckInFlight = false;
  let readyHooked = false;
  const log = deps.logger;

  /**
   * What the app believes about the overlay. Deliberately NOT called
   * "visible": `isVisible()` and `isAlwaysOnTop()` are Electron's own
   * bookkeeping, and both stay true when macOS has parked the window on a
   * Space the person is not looking at. This is what we can observe, not
   * proof that anybody can see it.
   */
  function floatBelief(): boolean {
    try {
      return deps.host.onTop();
    } catch {
      return false;
    }
  }

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

  /**
   * Place once, activate once, then hand it to the keeper.
   *
   * The activation is the part that survives a Space the window was not built
   * into — and it belongs here, at a presentation, rather than in the keeper's
   * ~1 Hz loop, which is where activating became focus-stealing.
   */
  function presentNow(): void {
    if (!isFront(active)) return;
    deps.host.place(specFor(active as ActivePrompt));
    deps.host.activate();
    deps.host.keep();
  }

  function stopHolding(): void {
    deps.host.release();
    stopResumePolling();
  }

  function startResumePolling(): void {
    if (resumeTimer || !resumeWhen) return;
    resumeTimer = setIntervalFn(checkResume, resumePollMs);
    resumeTimer.unref?.();
  }

  function stopResumePolling(): void {
    resumeWhen = null;
    if (!resumeTimer) return;
    clearIntervalFn(resumeTimer);
    resumeTimer = null;
  }

  function checkResume(): void {
    if (!resumeWhen || resumeCheckInFlight) return;
    const predicate = resumeWhen;
    resumeCheckInFlight = true;
    void Promise.resolve()
      .then(predicate)
      .then((done) => {
        if (done && resumeWhen === predicate) restoreActive();
      })
      .catch(() => {
        // A failing predicate must not wedge the prompt in a suspended state
        // forever; the next poll simply tries again.
      })
      .finally(() => {
        resumeCheckInFlight = false;
      });
  }

  function show(next: ActivePrompt): AttentionPrompt {
    const previous = active.kind;
    active = next;
    stopResumePolling();
    hookReadyOnce();
    deps.host.publish(active);
    presentNow();
    log?.info('attention prompt shown', {
      kind: next.kind,
      promptId: next.promptId,
      previous,
      floating: floatBelief(),
    });
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
      stopHolding();
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
   * top of the window they need — but come back by ourselves once `resumeWhen`
   * says the reason has passed. Without a predicate this was a one-way trip:
   * granting the permission left the prompt stranded behind Settings until the
   * user happened to click the tray.
   */
  function yieldPermissionToSystemSettings(promptId: string, opts: { resumeWhen?: ResumeWhen } = {}): boolean {
    if (active.kind !== 'PERMISSION' || active.promptId !== promptId) return false;
    active = { ...active, presentation: 'YIELDED_TO_SETTINGS' };
    stopResumePolling();
    resumeWhen = opts.resumeWhen ?? null;
    deps.host.publish(active);
    deps.host.lower();
    startResumePolling();
    return true;
  }

  /**
   * Put the active prompt back in front, and report whether there was one.
   *
   * The return value says a prompt EXISTS and was re-presented. It deliberately
   * does not claim the person can see it: macOS can hold the overlay on a Space
   * we were never told about, and Electron keeps reporting `isVisible()` true
   * throughout. Callers must therefore never treat `true` as a reason to leave
   * the person with no way into the app — see `releaseUnreachable`.
   */
  function restoreActive(): boolean {
    if (active.kind === 'NONE') return false;
    stopResumePolling();
    if (active.kind === 'PERMISSION' && active.presentation === 'YIELDED_TO_SETTINGS') {
      active = { ...active, presentation: 'FRONT' };
      deps.host.publish(active);
    }
    presentNow();
    log?.info('attention prompt restored', {
      kind: active.kind,
      promptId: active.promptId,
      floating: floatBelief(),
    });
    return true;
  }

  /**
   * Give up on a prompt the person evidently cannot reach.
   *
   * There is no API that reports "your window is on another Space", so the
   * evidence is behavioural: they asked for the app again, immediately after we
   * had just re-presented the prompt. Somebody who can see a prompt answers it;
   * somebody who cannot keeps clicking. Releasing it costs one unanswered
   * question and unblocks every route into the app.
   */
  function releaseUnreachable(reason: string): boolean {
    if (active.kind === 'NONE') return false;
    const released = active.kind;
    const promptId = active.promptId;
    stopResumePolling();
    stopHolding();
    active = { kind: 'NONE' };
    deps.host.publish(active);
    deps.host.hide();
    log?.warn('attention prompt released as unreachable', {
      kind: released,
      promptId,
      reason,
      floatingWhenReleased: floatBelief(),
    });
    return true;
  }

  function clear(promptId?: string): boolean {
    if (active.kind === 'NONE') return false;
    if (promptId && active.promptId !== promptId) return false;
    const cleared = active.kind;
    const clearedId = active.promptId;
    active = { kind: 'NONE' };
    stopHolding();
    deps.host.publish(active);
    deps.host.hide();
    log?.info('attention prompt cleared', { kind: cleared, promptId: clearedId });
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
    releaseUnreachable,
    clear,
    isPermissionActive: () => active.kind === 'PERMISSION',
    /** Test seam: run one resume poll without waiting on a real timer. */
    __resumeTickForTests: checkResume,
  };
}

let singleton: ReturnType<typeof createTrackingAttentionCoordinator> | null = null;

export function getTrackingAttentionCoordinator() {
  if (!singleton) {
    singleton = createTrackingAttentionCoordinator({ id: ulid, host: attentionHost, logger: log });
  }
  return singleton;
}
