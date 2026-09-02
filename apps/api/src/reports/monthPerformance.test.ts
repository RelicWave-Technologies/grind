import { describe, it, expect } from 'vitest';
import type { DayStatus, WorkingDayKind } from '@grind/types';
import type { PunchLookup } from '../attendance/punches';
import {
  buildMonthPerformance,
  codeForDay,
  fmtClock,
  fmtMinutes,
  formatMonthPerformanceCsv,
  monthDates,
  monthPerformanceBlock,
  type MonthPerformanceUser,
} from './monthPerformance';

/**
 * Presence comes from Timo's tracked time; holiday, weekly off and leave come
 * from the Lark-fed Working Calendar; the punch record supplies Office In and
 * Office Out and nothing else.
 *
 * The assertions that matter most are the ones about which source wins. A
 * calendar day off has to beat tracked time, tracked time has to beat a badge
 * reading, and neither may be quietly upgraded the way payroll would upgrade
 * it — that last one is what makes this an attendance record rather than a
 * pay sheet.
 */

const user: MonthPerformanceUser = {
  id: 'u1',
  name: 'Deepali Verma',
  email: 'deepali@emiactech.com',
  teamName: 'Technical',
};

function status(date: string, kind: WorkingDayKind, over: Partial<DayStatus> = {}): DayStatus {
  const away = kind === 'HOLIDAY' || kind === 'PAID_LEAVE' || kind === 'UNPAID_LEAVE';
  return {
    date,
    kind,
    portion: away ? 'FULL' : null,
    paid: kind === 'HOLIDAY' || kind === 'PAID_LEAVE',
    chargedDays: kind === 'PAID_LEAVE' ? 1 : 0,
    expectedFraction: away ? 0 : kind === 'WORKING' ? 1 : 0,
    shiftName: 'General',
    label: null,
    ...over,
  };
}

/** 'HH:MM' -> minutes since midnight, so the fixtures read like the report. */
function at(clock: string): number {
  const [h, m] = clock.split(':').map((n) => Number.parseInt(n, 10));
  return h! * 60 + m!;
}

const noPunches: PunchLookup = () => null;

function report(opts: {
  statuses?: Record<string, DayStatus>;
  punches?: Record<string, { in: string | null; out: string | null }>;
  /** Tracked minutes per date. Absent from the map means nothing tracked. */
  tracked?: Record<string, number>;
  month?: string;
}) {
  const month = opts.month ?? '2026-08';
  const punchFor: PunchLookup = opts.punches
    ? (_u, date) => {
        const p = opts.punches![date];
        return p ? { inMinute: p.in ? at(p.in) : null, outMinute: p.out ? at(p.out) : null } : null;
      }
    : noPunches;
  return buildMonthPerformance({
    month,
    tz: 'Asia/Kolkata',
    companyName: 'EMIAC TECHNOLOGIES PRIVATE LIMITED',
    users: [user],
    dayStatusFor: (_u, date) => opts.statuses?.[date] ?? null,
    trackedMinutesFor: (_u, date) => opts.tracked?.[date] ?? 0,
    punchFor,
    generatedAtMs: Date.UTC(2026, 8, 1),
  });
}

/** Codes keyed by date, which is what most assertions here are about. */
function codes(opts: Parameters<typeof report>[0]) {
  return Object.fromEntries(report(opts).rows[0]!.days.map((d) => [d.date, d.code]));
}

describe('a day is present or absent, with no minimum', () => {
  const working = (date: string) => status(date, 'WORKING');

  it.each([
    [12 * 60, 'P'],
    [8 * 60, 'P'],
    [4 * 60, 'P'],
    [30, 'P'],
    [1, 'P'],
    [0, 'A'],
  ])('%i tracked minutes reads %s', (minutes, expected) => {
    const c = codes({
      statuses: { '2026-08-03': working('2026-08-03') },
      tracked: { '2026-08-03': minutes },
    });
    expect(c['2026-08-03']).toBe(expected);
  });

  it('never produces a half day from hours, at any number of them', () => {
    // The only way to read HD is approved half-day leave. Hours cannot make one.
    for (const minutes of [1, 60, 4 * 60, 6 * 60, 8 * 60 - 1, 12 * 60]) {
      const c = codes({
        statuses: { '2026-08-03': working('2026-08-03') },
        tracked: { '2026-08-03': minutes },
      });
      expect(c['2026-08-03']).not.toBe('HD');
    }
  });

  it('marks a badged day absent only when nothing at all was tracked', () => {
    const built = report({
      statuses: {
        '2026-08-04': status('2026-08-04', 'WORKING'),
        '2026-08-05': status('2026-08-05', 'WORKING'),
      },
      punches: {
        '2026-08-04': { in: '09:55', out: '18:12' },
        '2026-08-05': { in: '09:40', out: '18:05' },
      },
      tracked: { '2026-08-04': 150 },
    });
    const byDate = new Map(built.rows[0]!.days.map((d) => [d.date, d]));
    // Two and a half hours is still work, so the day is present.
    expect(byDate.get('2026-08-04')!.code).toBe('P');
    expect(fmtMinutes(byDate.get('2026-08-04')!.workMinutes)).toBe('02:30');
    // Badged all day, nothing recorded: absent, and the badge times still show.
    expect(byDate.get('2026-08-05')!.code).toBe('A');
    expect(fmtClock(byDate.get('2026-08-05')!.punchInMinute)).toBe('09:40');
    expect(fmtClock(byDate.get('2026-08-05')!.punchOutMinute)).toBe('18:05');
  });

  it('counts a day with tracked time and no punch at all', () => {
    const c = codes({
      statuses: { '2026-08-03': status('2026-08-03', 'WORKING') },
      tracked: { '2026-08-03': 9 * 60 },
    });
    expect(c['2026-08-03']).toBe('P');
  });

  it('never upgrades a thin day because the month total was good', () => {
    // Payroll's monthly guarantee would upgrade every day once the month total
    // cleared a floor. Nothing here does that — each day stands on its own.
    const statuses: Record<string, DayStatus> = {};
    const tracked: Record<string, number> = {};
    for (let d = 1; d <= 19; d++) {
      const date = `2026-08-${String(d).padStart(2, '0')}`;
      statuses[date] = status(date, 'WORKING');
      tracked[date] = 9 * 60;
    }
    // Nothing tracked on the 20th, in a month that is otherwise full.
    statuses['2026-08-20'] = status('2026-08-20', 'WORKING');

    const c = codes({ statuses, tracked });
    expect(c['2026-08-01']).toBe('P');
    expect(c['2026-08-20']).toBe('A');
  });
});

describe('the calendar outranks tracked time', () => {
  it('names holiday, weekly off, paid leave and unpaid leave', () => {
    const c = codes({
      statuses: {
        '2026-08-03': status('2026-08-03', 'HOLIDAY', { label: 'Independence Day' }),
        '2026-08-04': status('2026-08-04', 'WEEKLY_OFF'),
        '2026-08-05': status('2026-08-05', 'PAID_LEAVE', { label: 'Paid leave' }),
        '2026-08-06': status('2026-08-06', 'UNPAID_LEAVE', { label: 'Unpaid leave' }),
      },
    });
    expect(c['2026-08-03']).toBe('HL');
    expect(c['2026-08-04']).toBe('WO');
    expect(c['2026-08-05']).toBe('PL');
    expect(c['2026-08-06']).toBe('LWP');
  });

  it('keeps the holiday code when somebody worked anyway, and still shows their hours', () => {
    const built = report({
      statuses: { '2026-08-03': status('2026-08-03', 'HOLIDAY', { label: 'Diwali' }) },
      punches: { '2026-08-03': { in: '09:27', out: '18:27' } },
      tracked: { '2026-08-03': 8 * 60 + 15 },
    });
    const day = built.rows[0]!.days.find((d) => d.date === '2026-08-03')!;
    expect(day.code).toBe('HL');
    expect(fmtMinutes(day.workMinutes)).toBe('08:15');
    expect(day.label).toBe('Diwali');
  });

  it('reads half-day leave as HD whether or not the other half was worked', () => {
    const half = (date: string) =>
      status(date, 'PAID_LEAVE', {
        portion: 'FIRST_HALF',
        expectedFraction: 0.5,
        chargedDays: 0.5,
        label: 'Paid leave',
      });
    const c = codes({
      statuses: { '2026-08-10': half('2026-08-10'), '2026-08-11': half('2026-08-11') },
      tracked: { '2026-08-10': 5 * 60 },
    });
    expect(c['2026-08-10']).toBe('HD');
    expect(c['2026-08-11']).toBe('HD');
  });

  it('says nothing about a day with no shift and nothing tracked, rather than absent', () => {
    expect(codes({ statuses: { '2026-08-03': status('2026-08-03', 'NO_SHIFT') } })['2026-08-03']).toBe('--');
    expect(codes({})['2026-08-03']).toBe('--');
  });

  it('still credits a no-shift day that was actually worked', () => {
    const c = codes({
      statuses: { '2026-08-03': status('2026-08-03', 'NO_SHIFT') },
      tracked: { '2026-08-03': 9 * 60 },
    });
    expect(c['2026-08-03']).toBe('P');
  });

  it('is a pure function of the two inputs', () => {
    expect(codeForDay(null, 1)).toBe('P');
    expect(codeForDay(null, 0)).toBe('--');
    expect(codeForDay(status('2026-08-03', 'WORKING'), 0)).toBe('A');
  });
});

describe('punches are shown as recorded, never invented', () => {
  it('prints a dash for a side that was not recorded', () => {
    const row = report({
      statuses: { '2026-08-03': status('2026-08-03', 'WORKING') },
      punches: { '2026-08-03': { in: '10:14', out: null } },
    }).rows[0]!;
    const day = row.days.find((d) => d.date === '2026-08-03')!;
    expect(fmtClock(day.punchInMinute)).toBe('10:14');
    expect(fmtClock(day.punchOutMinute)).toBe('--:--');
    expect(fmtClock(null)).toBe('--:--');
  });
});

describe('totals', () => {
  it('counts every day exactly once and sums work past 24 hours', () => {
    const statuses: Record<string, DayStatus> = {};
    const punches: Record<string, { in: string | null; out: string | null }> = {};
    for (const date of monthDates('2026-08')) statuses[date] = status(date, 'WORKING');
    statuses['2026-08-02'] = status('2026-08-02', 'WEEKLY_OFF');
    statuses['2026-08-15'] = status('2026-08-15', 'HOLIDAY');
    statuses['2026-08-17'] = status('2026-08-17', 'PAID_LEAVE');
    statuses['2026-08-18'] = status('2026-08-18', 'UNPAID_LEAVE');
    statuses['2026-08-19'] = status('2026-08-19', 'PAID_LEAVE', {
      portion: 'SECOND_HALF', expectedFraction: 0.5, chargedDays: 0.5,
    });
    // 18 worked days at 8:15 tracked each.
    const tracked: Record<string, number> = {};
    for (let d = 3; d <= 14; d++) tracked[`2026-08-${String(d).padStart(2, '0')}`] = 8 * 60 + 15;
    for (let d = 20; d <= 25; d++) tracked[`2026-08-${String(d).padStart(2, '0')}`] = 8 * 60 + 15;

    const totals = report({ statuses, punches, tracked }).rows[0]!.totals;
    expect(totals).toMatchObject({
      present: 18, weeklyOff: 1, holiday: 1, paidLeave: 1, unpaidLeave: 1, halfDay: 1, noShift: 0,
    });
    // 31 days, every one accounted for by exactly one code.
    const counted = totals.present + totals.halfDay + totals.weeklyOff + totals.holiday
      + totals.paidLeave + totals.unpaidLeave + totals.absent + totals.noShift;
    expect(counted).toBe(31);
    expect(fmtMinutes(totals.workMinutes)).toBe('148:30'); // 18 x 8:15
  });

  it('sums a long day into the month total without wrapping', () => {
    const totals = report({
      statuses: { '2026-08-03': status('2026-08-03', 'WORKING') },
      tracked: { '2026-08-03': 11 * 60 + 58 },
    }).rows[0]!.totals;
    expect(fmtMinutes(totals.workMinutes)).toBe('11:58');
  });
});

describe('the grid', () => {
  it('spans the whole month even when only a few days have anything', () => {
    expect(monthDates('2026-08')).toHaveLength(31);
    expect(monthDates('2026-02')).toHaveLength(28);
    expect(monthDates('2028-02')).toHaveLength(29);
    const built = report({ punches: { '2026-08-03': { in: '09:00', out: '18:00' } } });
    expect(built.dates).toHaveLength(31);
    expect(built.monthLabel).toBe('August-2026');
  });

  it('lays a person out as the eight rows the report uses', () => {
    const built = report({ statuses: { '2026-08-01': status('2026-08-01', 'WORKING') } });
    const block = monthPerformanceBlock(built, built.rows[0]!);
    expect(block).toHaveLength(8);
    expect(block[0]!.slice(0, 2)).toEqual(['Dept. Name', 'Technical']);
    expect(block[2]!.slice(1, 4)).toEqual(['1', '2', '3']);
    expect(block[3]![1]).toBe('Sat'); // 2026-08-01 is a Saturday
    expect(block.slice(4).map((r) => r[0])).toEqual([
      'Office In', 'Office Out', 'Total Working Hours', 'Status',
    ]);
    // Label column plus one cell per day of the month.
    for (const row of block.slice(2)) expect(row).toHaveLength(32);
  });

  it('quotes a name containing a comma so the CSV keeps its shape', () => {
    const built = report({});
    built.rows[0]!.user.name = 'Verma, Deepali';
    const csv = formatMonthPerformanceCsv(built);
    expect(csv).toContain('"Verma, Deepali"');
    expect(csv.split('\n')[2]!.split(',')).toHaveLength(32);
  });
});

describe('durations are hours, not a time of day', () => {
  it('does not wrap a month total at 24 hours', () => {
    expect(fmtMinutes(146 * 60 + 20)).toBe('146:20');
    expect(fmtMinutes(0)).toBe('00:00');
  });
});

describe('a human correction to a day', () => {
  const overrideReport = (opts: {
    statuses?: Record<string, DayStatus>;
    tracked?: Record<string, number>;
    overrides?: Record<string, { code: 'P' | 'A' | 'HD' | 'PL' | 'LWP'; computedCode: string | null }>;
  }) =>
    buildMonthPerformance({
      month: '2026-08',
      tz: 'Asia/Kolkata',
      companyName: 'EMIAC',
      users: [user],
      dayStatusFor: (_u, date) => opts.statuses?.[date] ?? null,
      trackedMinutesFor: (_u, date) => opts.tracked?.[date] ?? 0,
      punchFor: noPunches,
      overrideFor: (_u, date) => opts.overrides?.[date] ?? null,
      generatedAtMs: Date.UTC(2026, 8, 1),
    });

  const dayOf = (r: ReturnType<typeof overrideReport>, date: string) =>
    r.rows[0]!.days.find((d) => d.date === date)!;

  it('wins over an absent day the machine could not vouch for', () => {
    // The Pallavi case: badged in all day, agent died at 15:37, nothing tracked.
    const built = overrideReport({
      statuses: { '2026-08-31': status('2026-08-31', 'WORKING') },
      overrides: { '2026-08-31': { code: 'P', computedCode: 'A' } },
    });
    const day = dayOf(built, '2026-08-31');
    expect(day.code).toBe('P');
    expect(day.override).toEqual({ code: 'P', stale: false });
  });

  it('wins over the calendar too', () => {
    const built = overrideReport({
      statuses: { '2026-08-17': status('2026-08-17', 'PAID_LEAVE', { label: 'Paid leave' }) },
      overrides: { '2026-08-17': { code: 'P', computedCode: 'PL' } },
    });
    expect(dayOf(built, '2026-08-17').code).toBe('P');
  });

  it('leaves the hours alone — they still report what was tracked', () => {
    const built = overrideReport({
      statuses: { '2026-08-31': status('2026-08-31', 'WORKING') },
      tracked: { '2026-08-31': 337 },
      overrides: { '2026-08-31': { code: 'P', computedCode: 'A' } },
    });
    const day = dayOf(built, '2026-08-31');
    expect(day.code).toBe('P');
    expect(fmtMinutes(day.workMinutes)).toBe('05:37');
  });

  it('flags a day whose computed answer has changed since the correction', () => {
    // Marked present when the day computed as A. Leave has since arrived from
    // Lark, so the two no longer agree about a day they once agreed on.
    const built = overrideReport({
      statuses: { '2026-08-17': status('2026-08-17', 'PAID_LEAVE') },
      overrides: { '2026-08-17': { code: 'P', computedCode: 'A' } },
    });
    const day = dayOf(built, '2026-08-17');
    expect(day.code).toBe('P');
    expect(day.override).toEqual({ code: 'P', stale: true });
  });

  it('counts the corrected code, not the computed one', () => {
    const statuses: Record<string, DayStatus> = {};
    for (const d of monthDates('2026-08')) statuses[d] = status(d, 'WORKING');
    const built = overrideReport({
      statuses,
      overrides: {
        '2026-08-03': { code: 'P', computedCode: 'A' },
        '2026-08-04': { code: 'PL', computedCode: 'A' },
      },
    });
    expect(built.rows[0]!.totals.present).toBe(1);
    expect(built.rows[0]!.totals.paidLeave).toBe(1);
  });

  it('leaves an uncorrected day exactly as it was', () => {
    const built = overrideReport({
      statuses: { '2026-08-03': status('2026-08-03', 'WORKING') },
      tracked: { '2026-08-03': 480 },
    });
    const day = dayOf(built, '2026-08-03');
    expect(day.code).toBe('P');
    expect(day.override).toBeNull();
  });
});
