/**
 * Pure state machine for the "Are you working?" nudge.
 *
 * The shift reducer in `decide.ts` only covers the moment a shift opens. This
 * one covers the rest of the day: the user is demonstrably at the machine,
 * inside their shift, and no timer is running. That is the shape of forgetting
 * to press start, and it is the single biggest source of untracked work.
 *
 * The whole design problem here is not detecting the state — it is not being
 * annoying. Three rules do that work:
 *
 *  1. **Only count time the user was actually there.** The streak is driven by
 *     the OS idle timer, not the wall clock, so a laptop left open over lunch
 *     never accumulates toward a nudge. Walking away resets it.
 *  2. **Only inside the shift.** No nudges at 11pm or on a day off.
 *  3. **Never stack on another prompt.** Idle, away and permission prompts all
 *     outrank this one; it yields rather than piling a second toast on screen.
 *
 * The reducer returns one action per tick and never touches Electron, so the
 * timing rules can be tested exhaustively without a window on screen.
 */

/** Active-but-untracked time needed before the first nudge. */
export const ACTIVE_STREAK_MS = 10 * 60_000;

/** How long "Not now" buys. */
export const SNOOZE_MS = 30 * 60_000;

/**
 * OS idle time that counts as "not at the machine". Deliberately short: a
 * minute of no input is enough to say the streak should not keep growing,
 * and it means a break never silently matures into a nudge.
 */
export const AWAY_RESET_SEC = 60;

export interface UntrackedNudgeState {
  /** Epoch ms when the current active-and-untracked streak began. */
  activeSince: number | null;
  /** Epoch ms before which we stay quiet, set by "Not now". */
  snoozedUntil: number | null;
  /** True while the toast is on screen. Prevents re-showing it every tick. */
  prompting: boolean;
}

export type UntrackedAction = { kind: 'show' } | { kind: 'hide' } | { kind: 'noop' };

export const UNTRACKED_INITIAL_STATE: UntrackedNudgeState = {
  activeSince: null,
  snoozedUntil: null,
  prompting: false,
};

export interface UntrackedTickInput {
  state: UntrackedNudgeState;
  /** Epoch ms. */
  now: number;
  /** Inside the user's assigned shift window. */
  inShift: boolean;
  /** A timer is currently running. */
  tracking: boolean;
  /** `powerMonitor.getSystemIdleTime()`. */
  idleSeconds: number;
  /** An idle / away / permission prompt already owns the screen. */
  attentionBusy: boolean;
}

export interface UntrackedTickResult {
  state: UntrackedNudgeState;
  action: UntrackedAction;
}

/** Drop the toast if it is up, and forget the streak. */
function stand(state: UntrackedNudgeState): UntrackedTickResult {
  const next = { ...state, activeSince: null, prompting: false };
  return { state: next, action: state.prompting ? { kind: 'hide' } : { kind: 'noop' } };
}

export function tickUntrackedNudge(input: UntrackedTickInput): UntrackedTickResult {
  const { state, now } = input;

  // Tracking, off-shift, or away: nothing to nudge about, and a toast left
  // over from before is now stale.
  if (input.tracking || !input.inShift || input.idleSeconds >= AWAY_RESET_SEC) return stand(state);

  // Something more urgent owns the screen. Yield, and let the streak lapse
  // rather than banking it: the prompt in the way is usually the idle one,
  // which means the user was away, and counting that as untracked work would
  // nudge them about time they never spent working.
  if (input.attentionBusy) {
    return {
      state: { ...state, prompting: false },
      action: state.prompting ? { kind: 'hide' } : { kind: 'noop' },
    };
  }

  // Start (or continue) the streak.
  const activeSince = state.activeSince ?? now;
  const next = { ...state, activeSince };

  // "Not now" is a promise to stay quiet, not to forget: the streak keeps
  // running underneath, so the moment the snooze lapses on a user who never
  // did start tracking, the nudge returns rather than restarting its clock.
  if (state.snoozedUntil !== null && now < state.snoozedUntil) {
    return { state: next, action: { kind: 'noop' } };
  }

  if (state.prompting) return { state: next, action: { kind: 'noop' } };
  if (now - activeSince < ACTIVE_STREAK_MS) return { state: next, action: { kind: 'noop' } };

  return { state: { ...next, prompting: true, snoozedUntil: null }, action: { kind: 'show' } };
}

/** User pressed "Yes" — tracking is starting, so the streak is over. */
export function acceptUntrackedNudge(state: UntrackedNudgeState): UntrackedNudgeState {
  return { ...state, activeSince: null, snoozedUntil: null, prompting: false };
}

/** User pressed "Not now". */
export function snoozeUntrackedNudge(
  state: UntrackedNudgeState,
  now: number,
  snoozeMs = SNOOZE_MS,
): UntrackedNudgeState {
  return { ...state, snoozedUntil: now + snoozeMs, prompting: false };
}
