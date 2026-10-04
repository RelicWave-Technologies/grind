import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STREAK_MS,
  SNOOZE_MS,
  UNTRACKED_INITIAL_STATE,
  acceptUntrackedNudge,
  snoozeUntrackedNudge,
  tickUntrackedNudge,
  type UntrackedAction,
  type UntrackedNudgeState,
  type UntrackedTickInput,
} from './untracked';

const T0 = Date.UTC(2026, 7, 10, 5, 0, 0); // 10:30 IST, mid-shift
const MINUTE = 60_000;

/** A user sitting at their machine, in shift, with no timer running. */
function working(over: Partial<UntrackedTickInput> = {}): UntrackedTickInput {
  return {
    state: UNTRACKED_INITIAL_STATE,
    now: T0,
    inShift: true,
    tracking: false,
    idleSeconds: 2,
    attentionBusy: false,
    ...over,
  };
}

/**
 * Tick once a minute from T0 through T0+minutes, threading state through so
 * the streak accumulates exactly as it would in the running service.
 */
function runMinutes(minutes: number, over: Partial<UntrackedTickInput> = {}) {
  let state: UntrackedNudgeState = over.state ?? UNTRACKED_INITIAL_STATE;
  const actions: UntrackedAction[] = [];
  for (let minute = 0; minute <= minutes; minute += 1) {
    const result = tickUntrackedNudge(working({ ...over, state, now: T0 + minute * MINUTE }));
    state = result.state;
    actions.push(result.action);
  }
  return {
    state,
    action: actions[actions.length - 1] as UntrackedAction,
    // Whether the toast came up at ANY point. Asserting only on the final
    // action hides a nudge that fired mid-run and then went quiet because
    // `prompting` was already set.
    shown: actions.some((a) => a.kind === 'show'),
  };
}

describe('tickUntrackedNudge', () => {
  it('stays quiet before the streak matures', () => {
    const { action } = runMinutes(9);
    expect(action).toEqual({ kind: 'noop' });
  });

  it('asks once the user has been working untracked for the full streak', () => {
    const { state, action } = runMinutes(10);
    expect(action).toEqual({ kind: 'show' });
    expect(state.prompting).toBe(true);
  });

  it('does not ask again on every following tick', () => {
    const matured = runMinutes(10);
    const next = tickUntrackedNudge(working({ state: matured.state, now: T0 + 11 * MINUTE }));
    expect(next.action).toEqual({ kind: 'noop' });
  });

  it('never asks while a timer is already running', () => {
    expect(runMinutes(30, { tracking: true }).shown).toBe(false);
  });

  it('never asks outside the shift', () => {
    expect(runMinutes(30, { inShift: false }).shown).toBe(false);
  });
});

describe('not being annoying', () => {
  it('does not let a lunch break mature into a nudge', () => {
    // Away for 40 minutes: wall-clock time passes, but the streak is driven by
    // the idle timer, so nothing accumulates and nobody is nagged on return.
    const away = runMinutes(40, { idleSeconds: 15 * 60 });
    expect(away.shown).toBe(false);
    expect(away.state.activeSince).toBeNull();

    // Back at the desk: the clock starts from scratch.
    const backAtDesk = tickUntrackedNudge(working({ state: away.state, now: T0 + 41 * MINUTE }));
    expect(backAtDesk.action).toEqual({ kind: 'noop' });
    expect(backAtDesk.state.activeSince).toBe(T0 + 41 * MINUTE);
  });

  it('takes a stale toast down when the user walks away', () => {
    const matured = runMinutes(10);
    const walkedOff = tickUntrackedNudge(
      working({ state: matured.state, now: T0 + 20 * MINUTE, idleSeconds: 5 * 60 }),
    );
    expect(walkedOff.action).toEqual({ kind: 'hide' });
    expect(walkedOff.state.prompting).toBe(false);
  });

  it('takes the toast down as soon as tracking starts', () => {
    const matured = runMinutes(10);
    const started = tickUntrackedNudge(
      working({ state: matured.state, now: T0 + 11 * MINUTE, tracking: true }),
    );
    expect(started.action).toEqual({ kind: 'hide' });
  });

  it('yields to an idle, away or permission prompt instead of stacking', () => {
    const busy = runMinutes(10, { attentionBusy: true });
    expect(busy.shown).toBe(false);
    expect(busy.state.prompting).toBe(false);
  });

  it('does not bank time spent behind another prompt', () => {
    // The prompt in the way is usually the idle one, which means the user was
    // away. Banking that time would nudge them about work they never did, so
    // the streak restarts once the screen is theirs again.
    const busy = runMinutes(10, { attentionBusy: true });
    const cleared = tickUntrackedNudge(working({ state: busy.state, now: T0 + 11 * MINUTE }));

    expect(cleared.action).toEqual({ kind: 'noop' });
    expect(cleared.state.activeSince).toBe(T0 + 11 * MINUTE);
  });

  it('asks again after a fresh streak once the screen is free', () => {
    const busy = runMinutes(10, { attentionBusy: true });
    const { action } = runMinutes(10, { state: busy.state });

    expect(action).toEqual({ kind: 'show' });
  });
});

describe('"Not now"', () => {
  it('stays quiet for the whole snooze', () => {
    const matured = runMinutes(10);
    const snoozed = snoozeUntrackedNudge(matured.state, T0 + 10 * MINUTE);

    const midway = tickUntrackedNudge(
      working({ state: snoozed, now: T0 + 10 * MINUTE + SNOOZE_MS - MINUTE }),
    );
    expect(midway.action).toEqual({ kind: 'noop' });
  });

  it('comes back the moment the snooze lapses on a user who still has not started', () => {
    const matured = runMinutes(10);
    const snoozed = snoozeUntrackedNudge(matured.state, T0 + 10 * MINUTE);

    const after = tickUntrackedNudge(
      working({ state: snoozed, now: T0 + 10 * MINUTE + SNOOZE_MS + 1_000 }),
    );
    expect(after.action).toEqual({ kind: 'show' });
  });

  it('requires a fresh streak if the user left during the snooze', () => {
    const matured = runMinutes(10);
    let state = snoozeUntrackedNudge(matured.state, T0 + 10 * MINUTE);
    state = tickUntrackedNudge(
      working({ state, now: T0 + 20 * MINUTE, idleSeconds: 10 * 60 }),
    ).state;

    const justBack = tickUntrackedNudge(
      working({ state, now: T0 + 10 * MINUTE + SNOOZE_MS + 1_000 }),
    );
    expect(justBack.action).toEqual({ kind: 'noop' });
  });
});

describe('user decisions', () => {
  it('clears everything when the user says yes', () => {
    const matured = runMinutes(10);
    const accepted = acceptUntrackedNudge(matured.state);

    expect(accepted).toEqual({ activeSince: null, snoozedUntil: null, prompting: false });
  });

  it('uses the configured snooze length', () => {
    const snoozed = snoozeUntrackedNudge(UNTRACKED_INITIAL_STATE, T0);
    expect(snoozed.snoozedUntil).toBe(T0 + SNOOZE_MS);
    expect(snoozed.prompting).toBe(false);
  });

  it('agrees with the documented ten-minute streak', () => {
    expect(ACTIVE_STREAK_MS).toBe(10 * MINUTE);
    expect(SNOOZE_MS).toBe(30 * MINUTE);
  });
});
