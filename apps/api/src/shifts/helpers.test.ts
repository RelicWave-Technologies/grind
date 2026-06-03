import { describe, it, expect } from 'vitest';
import {
  hhmmToMin,
  minToHhmm,
  weekdayKey,
  todaysSchedule,
  isInsideShiftStartWindow,
  nextShiftStartMs,
  ShiftScheduleSchema,
  DayScheduleSchema,
  CreateShiftSchema,
  NINE_TO_SIX,
  EMPTY_SCHEDULE,
} from '@grind/types';

/**
 * Pure tests for the shift-helper layer. No DB, no Express. Locks the
 * mental model of how the agent + dashboard + API all interpret the
 * schedule, so anyone touching it later doesn't drift the contract.
 */

describe('hhmmToMin / minToHhmm', () => {
  it('round-trips canonical times', () => {
    for (const t of ['00:00', '09:00', '09:30', '12:00', '23:59']) {
      expect(minToHhmm(hhmmToMin(t))).toBe(t);
    }
  });
  it('hhmmToMin handles edges', () => {
    expect(hhmmToMin('00:00')).toBe(0);
    expect(hhmmToMin('00:01')).toBe(1);
    expect(hhmmToMin('12:00')).toBe(720);
    expect(hhmmToMin('23:59')).toBe(1439);
  });
});

describe('weekdayKey', () => {
  it('matches JS getDay()', () => {
    // 2026-06-01 is a Monday.
    expect(weekdayKey(new Date('2026-06-01T08:00:00'))).toBe('mon');
    expect(weekdayKey(new Date('2026-06-02T08:00:00'))).toBe('tue');
    expect(weekdayKey(new Date('2026-06-06T08:00:00'))).toBe('sat');
    expect(weekdayKey(new Date('2026-06-07T08:00:00'))).toBe('sun');
  });
});

describe('todaysSchedule', () => {
  it("returns the day's window on a working day", () => {
    const mon = new Date('2026-06-01T08:00:00');
    expect(todaysSchedule(NINE_TO_SIX, mon)).toEqual({ start: '09:00', end: '18:00' });
  });
  it('returns null on a day-off', () => {
    const sat = new Date('2026-06-06T08:00:00');
    expect(todaysSchedule(NINE_TO_SIX, sat)).toBeNull();
  });
});

describe('isInsideShiftStartWindow', () => {
  it('false BEFORE start time', () => {
    const beforeStart = new Date('2026-06-01T08:30:00');
    expect(
      isInsideShiftStartWindow({ schedule: NINE_TO_SIX, bufferMin: 30, now: beforeStart }),
    ).toBe(false);
  });
  it('true at the exact start time', () => {
    const atStart = new Date('2026-06-01T09:00:00');
    expect(
      isInsideShiftStartWindow({ schedule: NINE_TO_SIX, bufferMin: 30, now: atStart }),
    ).toBe(true);
  });
  it('true within the buffer window (start + bufferMin)', () => {
    const inBuffer = new Date('2026-06-01T09:25:00');
    expect(
      isInsideShiftStartWindow({ schedule: NINE_TO_SIX, bufferMin: 30, now: inBuffer }),
    ).toBe(true);
  });
  it('true at the exact end of the buffer (inclusive)', () => {
    const edge = new Date('2026-06-01T09:30:00');
    expect(
      isInsideShiftStartWindow({ schedule: NINE_TO_SIX, bufferMin: 30, now: edge }),
    ).toBe(true);
  });
  it('false AFTER the buffer expires', () => {
    const after = new Date('2026-06-01T09:31:00');
    expect(
      isInsideShiftStartWindow({ schedule: NINE_TO_SIX, bufferMin: 30, now: after }),
    ).toBe(false);
  });
  it('false on a non-working day', () => {
    const sat = new Date('2026-06-06T09:15:00');
    expect(
      isInsideShiftStartWindow({ schedule: NINE_TO_SIX, bufferMin: 30, now: sat }),
    ).toBe(false);
  });
  it('false for empty schedule', () => {
    expect(
      isInsideShiftStartWindow({ schedule: EMPTY_SCHEDULE, bufferMin: 30, now: new Date() }),
    ).toBe(false);
  });
  it('bufferMin=0 → only fires AT the start time', () => {
    expect(
      isInsideShiftStartWindow({ schedule: NINE_TO_SIX, bufferMin: 0, now: new Date('2026-06-01T09:00:00') }),
    ).toBe(true);
    expect(
      isInsideShiftStartWindow({ schedule: NINE_TO_SIX, bufferMin: 0, now: new Date('2026-06-01T09:01:00') }),
    ).toBe(false);
  });
});

describe('nextShiftStartMs', () => {
  it('returns today\'s start when called before it', () => {
    const at8 = new Date('2026-06-01T08:00:00');
    const next = nextShiftStartMs({ schedule: NINE_TO_SIX, now: at8 });
    expect(next).not.toBeNull();
    expect(new Date(next!).getHours()).toBe(9);
    expect(new Date(next!).getDate()).toBe(1);
  });

  it('returns tomorrow\'s start when called after today\'s', () => {
    const at10 = new Date('2026-06-01T10:00:00');
    const next = nextShiftStartMs({ schedule: NINE_TO_SIX, now: at10 });
    expect(next).not.toBeNull();
    expect(new Date(next!).getDate()).toBe(2); // Tue
    expect(new Date(next!).getHours()).toBe(9);
  });

  it('skips the weekend', () => {
    // Fri 2026-06-05 at 19:00. Next should be Mon 2026-06-08 09:00.
    const friEvening = new Date('2026-06-05T19:00:00');
    const next = nextShiftStartMs({ schedule: NINE_TO_SIX, now: friEvening });
    expect(next).not.toBeNull();
    expect(new Date(next!).getDay()).toBe(1); // Mon
  });

  it('returns null for fully-empty schedule', () => {
    const now = new Date('2026-06-01T09:00:00');
    expect(nextShiftStartMs({ schedule: EMPTY_SCHEDULE, now })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Zod validation
// ---------------------------------------------------------------------------

describe('DayScheduleSchema', () => {
  it('accepts a well-formed day', () => {
    expect(DayScheduleSchema.safeParse({ start: '09:00', end: '18:00' }).success).toBe(true);
  });
  it('accepts null = day off', () => {
    expect(DayScheduleSchema.safeParse(null).success).toBe(true);
  });
  it('rejects HH:MM out of range', () => {
    expect(DayScheduleSchema.safeParse({ start: '24:00', end: '25:00' }).success).toBe(false);
    expect(DayScheduleSchema.safeParse({ start: '09:60', end: '10:00' }).success).toBe(false);
  });
  it('rejects end <= start', () => {
    expect(DayScheduleSchema.safeParse({ start: '18:00', end: '09:00' }).success).toBe(false);
    expect(DayScheduleSchema.safeParse({ start: '09:00', end: '09:00' }).success).toBe(false);
  });
});

describe('ShiftScheduleSchema', () => {
  it('requires all 7 weekday keys', () => {
    const r = ShiftScheduleSchema.safeParse({
      mon: { start: '09:00', end: '18:00' },
      tue: null,
      wed: null,
      thu: null,
      fri: null,
      sat: null,
      // missing sun
    });
    expect(r.success).toBe(false);
  });
  it('accepts the NINE_TO_SIX preset', () => {
    expect(ShiftScheduleSchema.safeParse(NINE_TO_SIX).success).toBe(true);
  });
});

describe('CreateShiftSchema', () => {
  it('defaults bufferMin to 30', () => {
    const r = CreateShiftSchema.parse({ name: 'Day', schedule: NINE_TO_SIX });
    expect(r.bufferMin).toBe(30);
  });
  it('rejects empty name (whitespace trimmed)', () => {
    expect(CreateShiftSchema.safeParse({ name: '   ', schedule: NINE_TO_SIX }).success).toBe(false);
  });
  it('clamps bufferMin to <= 240', () => {
    expect(CreateShiftSchema.safeParse({ name: 'X', schedule: NINE_TO_SIX, bufferMin: 300 }).success).toBe(false);
  });
});
