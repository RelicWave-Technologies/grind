import { describe, expect, it } from 'vitest';
import type { ShiftSchedule } from '@grind/types';
import type { MonthPerformanceCode, MonthPerformanceDay } from './monthPerformance';
import { buildMonthPointers } from './monthPointers';

const NINE_TO_SIX: ShiftSchedule = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: { start: '09:00', end: '18:00' },
  sun: null,
};

const WEEKDAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Days are laid out from Monday 2026-08-03 onwards, so the nth day made here is
 * the nth weekday from Monday — which is what lets a test say "the seventh day
 * is the Sunday this shift is off".
 */
function day(
  code: MonthPerformanceCode,
  workMinutes: number,
  punch?: { in: number | null; out: number | null },
  index = 0,
): MonthPerformanceDay {
  const dayOfMonth = 3 + index;
  const date = `2026-08-${String(dayOfMonth).padStart(2, '0')}`;
  return {
    date,
    dayOfMonth,
    weekday: WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]!,
    punchInMinute: punch?.in ?? null,
    punchOutMinute: punch?.out ?? null,
    workMinutes,
    code,
    label: null,
    override: null,
  };
}

/** Re-dates a hand-built list so the days land on consecutive calendar days. */
function run(days: MonthPerformanceDay[], schedule: ShiftSchedule | null = NINE_TO_SIX, bufferMin = 30) {
  const dated = days.map((d, i) => day(d.code, d.workMinutes, { in: d.punchInMinute, out: d.punchOutMinute }, i));
  return buildMonthPointers({ days: dated, schedule, bufferMin });
}

describe('buildMonthPointers', () => {
  it('counts only worked days, so leave does not drag the average down', () => {
    const p = run([
      day('P', 480),
      day('PL', 0),
      day('WO', 0),
      day('HL', 0),
      day('A', 0),
      day('P', 480),
    ]);

    expect(p.workedDays).toBe(2);
    expect(p.workMinutes).toBe(960);
    expect(p.averageMinutes).toBe(480);
    expect(p.band).toBe('YELLOW');
  });

  it('gives a month with no worked days no band at all', () => {
    const p = run([day('WO', 0), day('PL', 0), day('A', 0)]);

    expect(p.workedDays).toBe(0);
    expect(p.averageMinutes).toBe(0);
    // Not RED: a 0:00 average here means "nothing to judge", not "critical".
    expect(p.band).toBeNull();
  });

  it('bands on the average, tiling the range with no gap between them', () => {
    expect(run([day('P', 419)]).band).toBe('RED');
    expect(run([day('P', 420)]).band).toBe('YELLOW');
    expect(run([day('P', 495)]).band).toBe('YELLOW');
    expect(run([day('P', 496)]).band).toBe('GREEN');
  });

  it('counts short and strong full days at the spec boundaries', () => {
    const p = run([
      day('P', 359), // under 6h
      day('P', 360), // exactly 6h — not short
      day('P', 539), // under 9h
      day('P', 540), // exactly 9h — strong
    ]);

    expect(p.fullDaysUnderSix).toBe(1);
    expect(p.fullDaysNineOrMore).toBe(1);
    expect(p.fullDays).toBe(4);
    expect(p.halfDays).toBe(0);
  });

  it('counts short and strong half days at the spec boundaries', () => {
    const p = run([
      day('HD', 120), // exactly 2h — short, the spec says "2 hours or less"
      day('HD', 121), // over 2h
      day('HD', 300), // exactly 5h — not strong, the spec says "more than 5"
      day('HD', 301), // over 5h — strong
    ]);

    expect(p.halfDaysUpToTwo).toBe(1);
    expect(p.halfDaysOverFive).toBe(1);
    expect(p.halfDays).toBe(4);
  });

  it('separates late against the shift start from late against the buffer', () => {
    const p = run([
      day('P', 480, { in: 9 * 60, out: 18 * 60 }), // 09:00 — on time either way
      day('P', 480, { in: 9 * 60 + 15, out: 18 * 60 }), // 09:15 — late, within grace
      day('P', 480, { in: 9 * 60 + 31, out: 18 * 60 }), // 09:31 — late both ways
    ]);

    expect(p.lateDays).toBe(2);
    expect(p.lateDaysAfterBuffer).toBe(1);
  });

  it('counts leaving before the shift end', () => {
    const p = run([
      day('P', 480, { in: 9 * 60, out: 18 * 60 }), // exactly 18:00 — not early
      day('P', 480, { in: 9 * 60, out: 17 * 60 + 59 }),
    ]);

    expect(p.earlyDays).toBe(1);
  });

  it('reports days with no punch rather than reading them as never late', () => {
    const p = run([
      day('P', 480), // no punch at all
      day('P', 480, { in: 9 * 60 + 45, out: null }), // punched in, never out
      day('P', 480, { in: 9 * 60 + 45, out: 18 * 60 }),
    ]);

    expect(p.daysWithoutPunch).toBe(2);
    expect(p.lateDays).toBe(1);
    expect(p.workedDays).toBe(3);
  });

  it('judges no arrival on a day the shift is off, but still counts the hours', () => {
    // Seven days from Monday, so the seventh is the Sunday this shift is off.
    const days = Array.from({ length: 7 }, () => day('P', 480, { in: 12 * 60, out: 13 * 60 }));
    const p = run(days);

    expect(p.workedDays).toBe(7);
    // Six judged days, all late and all early. The Sunday is judged on neither.
    expect(p.lateDays).toBe(6);
    expect(p.earlyDays).toBe(6);
    expect(p.daysWithoutPunch).toBe(0);
  });

  it('judges no arrival at all when the person has no shift', () => {
    const p = run([day('P', 480, { in: 12 * 60, out: 13 * 60 })], null);

    expect(p.workedDays).toBe(1);
    expect(p.lateDays).toBe(0);
    expect(p.earlyDays).toBe(0);
    expect(p.daysWithoutPunch).toBe(0);
  });

  it('reproduces a real August row — Dushyant Singh, 23 full days averaging 4:33', () => {
    // 21 of 23 days under six hours, and an average deep under the 7h line.
    const days = [
      ...Array.from({ length: 21 }, () => day('P', 240)),
      day('P', 480),
      day('P', 480),
    ];
    const p = run(days);

    expect(p.fullDays).toBe(23);
    expect(p.fullDaysUnderSix).toBe(21);
    expect(p.fullDaysNineOrMore).toBe(0);
    expect(p.band).toBe('RED');
  });
});
