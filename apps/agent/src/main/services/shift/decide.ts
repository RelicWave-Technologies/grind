import {
  isInsideShiftStartWindow,
  nextShiftStartMs,
  todaysSchedule,
  type ShiftSchedule,
} from '@grind/types';

/**
 * Pure state machine for the agent's "Ready to work?" popup.
 *
 * The popup fires when the user is INSIDE their shift-start window (start
 * time → start + bufferMin). It nudges every `nudgeIntervalMs` (default
 * 5 min). The user can:
 *   - click **Yes** → marks `ackedFor=<today's start>`; we stay silent
 *     until tomorrow's shift window opens.
 *   - click **Not yet** → marks `snoozedUntil=now+nudgeIntervalMs`; we
 *     re-show as soon as that snooze expires AND we're still in the
 *     buffer. After buffer expiry we stop bothering and reset, so
 *     tomorrow's window starts clean.
 *
 * The reducer returns ONE of four actions per tick. The agent service
 * translates those into `show()`, schedule a one-shot, or no-op.
 */

export interface ShiftMonitorState {
  /** Epoch ms of today's shift start the user has acknowledged with "Yes". */
  ackedFor: number | null;
  /** Epoch ms before which we hold off re-showing (set by "Not yet"). */
  snoozedUntil: number | null;
  /** True if the popup is currently visible. Prevents stacking. */
  prompting: boolean;
}

export type ShiftAction =
  | { kind: 'show'; startedAt: number; bufferUntil: number }
  | { kind: 'hide' /* popup is up but no longer in window — close it */ }
  | { kind: 'schedule'; nextAt: number /* one-shot timer instead of polling */ }
  | { kind: 'noop' };

const FIVE_MIN_MS = 5 * 60_000;

export function tickShiftMonitor(input: {
  schedule: ShiftSchedule | null;
  bufferMin: number;
  state: ShiftMonitorState;
  now: Date;
  nudgeIntervalMs?: number;
}): ShiftAction {
  if (!input.schedule) return { kind: 'noop' };
  const inWindow = isInsideShiftStartWindow({
    schedule: input.schedule,
    bufferMin: input.bufferMin,
    now: input.now,
  });

  // Resolve today's start (in local clock) — needed for both the "show"
  // action and the ack-key. Cheap; runs on every tick.
  const day = todaysSchedule(input.schedule, input.now);
  const todaysStartMs = day ? startOfDayClock(input.now, day.start) : null;
  const bufferUntilMs =
    todaysStartMs !== null ? todaysStartMs + Math.max(0, input.bufferMin) * 60_000 : null;

  if (!inWindow) {
    // Outside the buffer window. If a popup is up (e.g. we just expired),
    // close it. Otherwise schedule a one-shot for the next shift start so
    // we don't poll forever.
    if (input.state.prompting) return { kind: 'hide' };
    const nextAt = nextShiftStartMs({ schedule: input.schedule, now: input.now });
    return nextAt !== null ? { kind: 'schedule', nextAt } : { kind: 'noop' };
  }

  // Inside the buffer window. Three reasons to stay silent:
  //   1. user already acked this morning's prompt with "Yes"
  //   2. user said "Not yet" and the snooze hasn't elapsed
  //   3. popup is already showing
  if (input.state.ackedFor !== null && todaysStartMs !== null && input.state.ackedFor === todaysStartMs) {
    return { kind: 'noop' };
  }
  if (input.state.snoozedUntil !== null && input.now.getTime() < input.state.snoozedUntil) {
    return { kind: 'noop' };
  }
  if (input.state.prompting) return { kind: 'noop' };

  // Show it.
  return {
    kind: 'show',
    startedAt: todaysStartMs ?? input.now.getTime(),
    bufferUntil: bufferUntilMs ?? input.now.getTime() + (input.nudgeIntervalMs ?? FIVE_MIN_MS),
  };
}

/** Treat HH:MM as the user's local clock on the same calendar day as `now`. */
function startOfDayClock(now: Date, hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => Number.parseInt(n, 10));
  const d = new Date(now);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.getTime();
}

/** Apply user's "Yes" — acknowledge today's window. */
export function ackToday(state: ShiftMonitorState, schedule: ShiftSchedule, now: Date): ShiftMonitorState {
  const day = todaysSchedule(schedule, now);
  if (!day) return state;
  return { ...state, ackedFor: startOfDayClock(now, day.start), snoozedUntil: null, prompting: false };
}

/** Apply user's "Not yet" — snooze for `nudgeIntervalMs`. */
export function snooze(state: ShiftMonitorState, now: Date, nudgeIntervalMs = FIVE_MIN_MS): ShiftMonitorState {
  return { ...state, snoozedUntil: now.getTime() + nudgeIntervalMs, prompting: false };
}

/** Called when the buffer window expires without an explicit Yes — clears
 *  snooze so tomorrow starts fresh, doesn't mark as acked (user didn't say
 *  Yes). */
export function expire(state: ShiftMonitorState): ShiftMonitorState {
  return { ...state, snoozedUntil: null, prompting: false };
}

export const INITIAL_STATE: ShiftMonitorState = {
  ackedFor: null,
  snoozedUntil: null,
  prompting: false,
};
