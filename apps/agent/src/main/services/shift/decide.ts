import {
  instantForZonedDateTime,
  isValidTimeZone,
  zonedDateTimeParts,
  WEEKDAYS,
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
  timeZone: string;
  nudgeIntervalMs?: number;
}): ShiftAction {
  const timeZone = input.timeZone;
  if (!input.schedule || !isValidTimeZone(timeZone)) return { kind: 'noop' };
  const nowParts = zonedDateTimeParts(input.now, timeZone);
  const day = scheduleForDate(input.schedule, nowParts);
  const todaysStartMs = day ? shiftStartForDate(nowParts, day.start, timeZone) : null;
  const bufferUntilMs = todaysStartMs === null
    ? null
    : todaysStartMs + Math.max(0, input.bufferMin) * 60_000;
  const nowMs = input.now.getTime();
  const inWindow = todaysStartMs !== null
    && bufferUntilMs !== null
    && nowMs >= todaysStartMs
    && nowMs <= bufferUntilMs;

  if (!inWindow) {
    // Outside the buffer window. If a popup is up (e.g. we just expired),
    // close it. Otherwise schedule a one-shot for the next shift start so
    // we don't poll forever.
    if (input.state.prompting) return { kind: 'hide' };
    const nextAt = nextShiftStartMs(input.schedule, input.now, timeZone);
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

function shiftStartForDate(
  date: { year: number; month: number; day: number },
  hhmm: string,
  timeZone: string,
): number | null {
  const [h, m] = hhmm.split(':').map((n) => Number.parseInt(n, 10));
  try {
    return instantForZonedDateTime({
      year: date.year,
      month: date.month,
      day: date.day,
      hour: h ?? 0,
      minute: m ?? 0,
      second: 0,
    }, timeZone).getTime();
  } catch {
    return null;
  }
}

function scheduleForDate(
  schedule: ShiftSchedule,
  date: { year: number; month: number; day: number },
) {
  const weekday = WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()]!;
  return schedule[weekday];
}

function addCalendarDays(
  date: { year: number; month: number; day: number },
  offset: number,
): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + offset));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function nextShiftStartMs(schedule: ShiftSchedule, now: Date, timeZone: string): number | null {
  const today = zonedDateTimeParts(now, timeZone);
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = addCalendarDays(today, offset);
    const day = scheduleForDate(schedule, date);
    if (!day) continue;
    const startsAt = shiftStartForDate(date, day.start, timeZone);
    if (startsAt === null || startsAt < now.getTime()) continue;
    return startsAt;
  }
  return null;
}

/** Apply user's "Yes" — acknowledge today's window. */
export function ackToday(state: ShiftMonitorState, schedule: ShiftSchedule, now: Date, timeZone: string): ShiftMonitorState {
  if (!isValidTimeZone(timeZone)) return state;
  const date = zonedDateTimeParts(now, timeZone);
  const day = scheduleForDate(schedule, date);
  if (!day) return state;
  const startedAt = shiftStartForDate(date, day.start, timeZone);
  if (startedAt === null) return state;
  return { ...state, ackedFor: startedAt, snoozedUntil: null, prompting: false };
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
