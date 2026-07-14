import { describe, it, expect } from 'vitest';
import {
  tickShiftMonitor as tickShiftMonitorInTimeZone,
  ackToday as ackTodayInTimeZone,
  snooze,
  expire,
  INITIAL_STATE,
  type ShiftMonitorState,
} from './decide';
import { NINE_TO_SIX, EMPTY_SCHEDULE, zonedDateTimeParts, type ShiftSchedule } from '@grind/types';

/**
 * Pure tests for the ShiftMonitor reducer. The agent's service uses
 * this to translate (now, schedule, state) → action; the popup is
 * one-shot scheduled when outside the window so we don't poll forever.
 */

const TIME_ZONE = 'Asia/Kolkata';
const at = (yyyyMmDdHHmm: string) => new Date(`${yyyyMmDdHHmm}+05:30`);
const parts = (value: number) => zonedDateTimeParts(value, TIME_ZONE);
const tickShiftMonitor = (
  input: Omit<Parameters<typeof tickShiftMonitorInTimeZone>[0], 'timeZone'>,
) => tickShiftMonitorInTimeZone({ ...input, timeZone: TIME_ZONE });
const ackToday = (state: ShiftMonitorState, schedule: ShiftSchedule, now: Date) => (
  ackTodayInTimeZone(state, schedule, now, TIME_ZONE)
);

describe('tickShiftMonitor — no schedule', () => {
  it('null schedule → noop', () => {
    const r = tickShiftMonitor({
      schedule: null,
      bufferMin: 30,
      state: INITIAL_STATE,
      now: at('2026-06-01T09:00:00'),
    });
    expect(r).toEqual({ kind: 'noop' });
  });
});

describe('tickShiftMonitor — inside the buffer window', () => {
  it('first tick inside window → show, with bufferUntil at start+bufferMin', () => {
    const now = at('2026-06-01T09:00:00'); // Monday at exactly start
    const r = tickShiftMonitor({
      schedule: NINE_TO_SIX,
      bufferMin: 30,
      state: INITIAL_STATE,
      now,
    });
    expect(r.kind).toBe('show');
    if (r.kind !== 'show') throw new Error('narrow');
    expect(r.startedAt).toBe(now.getTime());
    expect(r.bufferUntil).toBe(now.getTime() + 30 * 60_000);
  });

  it('still inside but already prompting → noop (no stacking)', () => {
    const r = tickShiftMonitor({
      schedule: NINE_TO_SIX,
      bufferMin: 30,
      state: { ...INITIAL_STATE, prompting: true },
      now: at('2026-06-01T09:10:00'),
    });
    expect(r).toEqual({ kind: 'noop' });
  });

  it('inside window + already acked today → noop', () => {
    const now = at('2026-06-01T09:10:00');
    // 09:00 same day
    const ackedFor = at('2026-06-01T09:00:00').getTime();
    const r = tickShiftMonitor({
      schedule: NINE_TO_SIX,
      bufferMin: 30,
      state: { ...INITIAL_STATE, ackedFor },
      now,
    });
    expect(r).toEqual({ kind: 'noop' });
  });

  it('inside window + snoozed until > now → noop', () => {
    const now = at('2026-06-01T09:10:00');
    const r = tickShiftMonitor({
      schedule: NINE_TO_SIX,
      bufferMin: 30,
      state: { ...INITIAL_STATE, snoozedUntil: now.getTime() + 60_000 },
      now,
    });
    expect(r).toEqual({ kind: 'noop' });
  });

  it('inside window + snooze expired → show again', () => {
    const now = at('2026-06-01T09:10:00');
    const r = tickShiftMonitor({
      schedule: NINE_TO_SIX,
      bufferMin: 30,
      state: { ...INITIAL_STATE, snoozedUntil: now.getTime() - 1_000 },
      now,
    });
    expect(r.kind).toBe('show');
  });
});

describe('tickShiftMonitor — outside the window', () => {
  it('before today\'s start → schedule for today\'s start', () => {
    const now = at('2026-06-01T08:00:00');
    const r = tickShiftMonitor({
      schedule: NINE_TO_SIX,
      bufferMin: 30,
      state: INITIAL_STATE,
      now,
    });
    expect(r.kind).toBe('schedule');
    if (r.kind !== 'schedule') throw new Error('narrow');
    expect(parts(r.nextAt).hour).toBe(9);
    expect(parts(r.nextAt).day).toBe(1);
  });

  it('after buffer expires today → schedule for tomorrow\'s start', () => {
    const now = at('2026-06-01T10:00:00');
    const r = tickShiftMonitor({
      schedule: NINE_TO_SIX,
      bufferMin: 30,
      state: INITIAL_STATE,
      now,
    });
    expect(r.kind).toBe('schedule');
    if (r.kind !== 'schedule') throw new Error('narrow');
    expect(parts(r.nextAt).day).toBe(2);
  });

  it('weekend → schedule for Monday', () => {
    const now = at('2026-06-06T10:00:00'); // Saturday
    const r = tickShiftMonitor({
      schedule: NINE_TO_SIX,
      bufferMin: 30,
      state: INITIAL_STATE,
      now,
    });
    expect(r.kind).toBe('schedule');
    if (r.kind !== 'schedule') throw new Error('narrow');
    expect(new Date(Date.UTC(parts(r.nextAt).year, parts(r.nextAt).month - 1, parts(r.nextAt).day)).getUTCDay()).toBe(1); // Mon
  });

  it('outside window + popup currently visible → hide', () => {
    const r = tickShiftMonitor({
      schedule: NINE_TO_SIX,
      bufferMin: 30,
      state: { ...INITIAL_STATE, prompting: true },
      now: at('2026-06-01T10:00:00'),
    });
    expect(r).toEqual({ kind: 'hide' });
  });

  it('outside window + empty schedule → noop', () => {
    const r = tickShiftMonitor({
      schedule: EMPTY_SCHEDULE,
      bufferMin: 30,
      state: INITIAL_STATE,
      now: at('2026-06-01T09:00:00'),
    });
    expect(r).toEqual({ kind: 'noop' });
  });
});

describe('state mutators', () => {
  const base: ShiftMonitorState = { ...INITIAL_STATE, prompting: true };

  it('ackToday stamps today\'s start, clears snooze + prompting', () => {
    const now = at('2026-06-01T09:30:00');
    const next = ackToday({ ...base, snoozedUntil: 12345 }, NINE_TO_SIX, now);
    expect(next.ackedFor).toBe(at('2026-06-01T09:00:00').getTime());
    expect(next.snoozedUntil).toBeNull();
    expect(next.prompting).toBe(false);
  });

  it('ackToday is a no-op on a day-off (saturday)', () => {
    const sat = at('2026-06-06T09:30:00');
    const next = ackToday(base, NINE_TO_SIX, sat);
    expect(next).toEqual(base);
  });

  it('snooze sets snoozedUntil to now + interval; clears prompting', () => {
    const now = at('2026-06-01T09:10:00');
    const next = snooze(base, now, 7 * 60_000);
    expect(next.snoozedUntil).toBe(now.getTime() + 7 * 60_000);
    expect(next.prompting).toBe(false);
  });

  it('snooze default interval is 5 min', () => {
    const now = at('2026-06-01T09:10:00');
    const next = snooze(base, now);
    expect(next.snoozedUntil).toBe(now.getTime() + 5 * 60_000);
  });

  it('expire clears snooze + prompting but NEVER acks (user didn\'t say Yes)', () => {
    const next = expire({ ...base, snoozedUntil: 999, ackedFor: null });
    expect(next.snoozedUntil).toBeNull();
    expect(next.prompting).toBe(false);
    expect(next.ackedFor).toBeNull();
  });
});

describe('full lifecycle', () => {
  it('Yes-at-first-show stays silent for the rest of the buffer + tomorrow re-arms', () => {
    let st = INITIAL_STATE;
    const today9 = at('2026-06-01T09:00:00');
    let r = tickShiftMonitor({ schedule: NINE_TO_SIX, bufferMin: 30, state: st, now: today9 });
    expect(r.kind).toBe('show');
    st = ackToday({ ...st, prompting: true }, NINE_TO_SIX, today9);
    // 15 minutes later still inside buffer
    r = tickShiftMonitor({ schedule: NINE_TO_SIX, bufferMin: 30, state: st, now: at('2026-06-01T09:15:00') });
    expect(r).toEqual({ kind: 'noop' });
    // Tomorrow morning the ack key is for 06-01, today is 06-02 → re-fire
    r = tickShiftMonitor({ schedule: NINE_TO_SIX, bufferMin: 30, state: st, now: at('2026-06-02T09:00:00') });
    expect(r.kind).toBe('show');
  });

  it('Not-yet then re-fires after the 5-min snooze', () => {
    let st: ShiftMonitorState = { ...INITIAL_STATE, prompting: true };
    const t0 = at('2026-06-01T09:00:00');
    st = snooze(st, t0);
    // 4 minutes later → noop
    let r = tickShiftMonitor({ schedule: NINE_TO_SIX, bufferMin: 30, state: st, now: at('2026-06-01T09:04:00') });
    expect(r).toEqual({ kind: 'noop' });
    // 6 minutes later → show again
    r = tickShiftMonitor({ schedule: NINE_TO_SIX, bufferMin: 30, state: st, now: at('2026-06-01T09:06:00') });
    expect(r.kind).toBe('show');
  });

  it('Snooze past buffer expiry → no show, then scheduled for tomorrow', () => {
    let st: ShiftMonitorState = { ...INITIAL_STATE };
    st = snooze(st, at('2026-06-01T09:25:00')); // expires 09:30
    // 09:31 — past buffer
    const r = tickShiftMonitor({ schedule: NINE_TO_SIX, bufferMin: 30, state: st, now: at('2026-06-01T09:31:00') });
    expect(r.kind).toBe('schedule');
    if (r.kind !== 'schedule') throw new Error('narrow');
    expect(parts(r.nextAt).day).toBe(2);
  });
});
