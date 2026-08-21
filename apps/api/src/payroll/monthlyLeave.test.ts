import { describe, it, expect } from 'vitest';
import { buildMonthlyPayroll } from './monthly';
import type { TimesheetCell, TimesheetMatrix } from '../insights/timesheets';
import type { DayStatus, WorkingDayKind } from '@grind/types';

/**
 * Payroll's half of the leave feature: a day nobody tracked can still be a
 * payable day, and the report has to say WHY. These assertions are the
 * difference between "Deepali worked 0 hours on the 19th" and "the 19th was
 * Holi", which is the whole reason the calendar reaches payroll at all.
 */

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const user = {
  id: 'u1',
  name: 'Deepali',
  email: 'd@x.com',
  avatarUrl: null,
  role: 'MEMBER',
  teamId: null,
  teamName: null,
};

function status(
  date: string,
  kind: WorkingDayKind,
  over: Partial<DayStatus> = {},
): DayStatus {
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

function cell(workedH: number, dayStatus: DayStatus | null): TimesheetCell {
  return {
    workedMs: workedH * HOUR,
    meetingMs: 0,
    manualMs: 0,
    invalidatedMs: 0,
    totalMs: workedH * HOUR,
    firstActivityMs: null,
    lastActivityMs: null,
    activitySampleCount: 0,
    dayStatus,
  };
}

function matrixOf(cells: Record<string, TimesheetCell>): TimesheetMatrix {
  const days = Object.keys(cells).sort();
  return { from: days[0]!, to: days[days.length - 1]!, tz: 'UTC', days, cells: { u1: cells } };
}

function run(cells: Record<string, TimesheetCell>) {
  return buildMonthlyPayroll(
    { month: '2026-08', tz: 'UTC', matrix: matrixOf(cells), users: [user] },
    NOW,
  ).rows[0]!;
}

describe('a company holiday is a payable day nobody worked', () => {
  it('credits one unit and names the reason', () => {
    const row = run({ '2026-08-19': cell(0, status('2026-08-19', 'HOLIDAY', { label: 'Holi' })) });
    expect(row.payableUnits).toBe(1);
    expect(row.holidayDays).toBe(1);
    expect(row.payrollDays[0]!.status).toBe('HOLIDAY');
    expect(row.payrollDays[0]!.reason).toBe('company_holiday');
    expect(row.payrollDays[0]!.leaveLabel).toBe('Holi');
  });

  it('does not count as a day present, because nothing was tracked', () => {
    const row = run({ '2026-08-19': cell(0, status('2026-08-19', 'HOLIDAY')) });
    expect(row.daysPresent).toBe(0);
    expect(row.totalHours).toBe(0);
  });
});

describe('paid leave', () => {
  it('a full day credits one unit', () => {
    const row = run({ '2026-08-17': cell(0, status('2026-08-17', 'PAID_LEAVE')) });
    expect(row.payableUnits).toBe(1);
    expect(row.paidLeaveDays).toBe(1);
    expect(row.payrollDays[0]!.status).toBe('PAID_LEAVE');
  });

  it('a half day credits 0.5 and leaves the other half to be earned', () => {
    const half = status('2026-08-17', 'PAID_LEAVE', {
      portion: 'FIRST_HALF',
      chargedDays: 0.5,
      expectedFraction: 0.5,
    });
    // Five tracked hours clears the four-hour half-day threshold.
    const row = run({ '2026-08-17': cell(5, half) });
    expect(row.paidLeaveDays).toBe(0.5);
    expect(row.payableUnits).toBe(1);
    expect(row.payrollDays[0]!.leavePortion).toBe('FIRST_HALF');
  });

  it('a half day with nothing tracked still credits its 0.5', () => {
    const half = status('2026-08-17', 'PAID_LEAVE', {
      portion: 'SECOND_HALF',
      chargedDays: 0.5,
      expectedFraction: 0.5,
    });
    const row = run({ '2026-08-17': cell(0, half) });
    expect(row.payableUnits).toBe(0.5);
  });
});

describe('unpaid leave', () => {
  it('credits nothing but is still reported', () => {
    const row = run({ '2026-08-17': cell(0, status('2026-08-17', 'UNPAID_LEAVE', { paid: false })) });
    expect(row.payableUnits).toBe(0);
    expect(row.unpaidLeaveDays).toBe(1);
    expect(row.payrollDays[0]!.status).toBe('UNPAID_LEAVE');
    expect(row.payrollDays[0]!.reason).toBe('unpaid_leave');
  });
});

describe('worked and credited stay separable', () => {
  it('reports a month of work, holiday and leave as distinct columns', () => {
    const row = run({
      '2026-08-17': cell(9, status('2026-08-17', 'WORKING')),
      '2026-08-18': cell(9, status('2026-08-18', 'WORKING')),
      '2026-08-19': cell(0, status('2026-08-19', 'HOLIDAY', { label: 'Holi' })),
      '2026-08-20': cell(0, status('2026-08-20', 'PAID_LEAVE')),
      '2026-08-21': cell(0, status('2026-08-21', 'UNPAID_LEAVE', { paid: false })),
      '2026-08-22': cell(0, status('2026-08-22', 'WEEKLY_OFF')),
    });
    // Two worked days, one holiday, one paid leave — the unpaid day and the
    // weekend earn nothing.
    expect(row.payableUnits).toBe(4);
    expect(row.holidayDays).toBe(1);
    expect(row.paidLeaveDays).toBe(1);
    expect(row.unpaidLeaveDays).toBe(1);
    expect(row.fullDays).toBe(2);
    // Hours are hours; they never absorb the credited days.
    expect(row.totalHours).toBe(18);
    expect(row.daysPresent).toBe(2);
  });

  it('an absence takes no part in the tracked-time carry allocator', () => {
    // A short day would normally scavenge carry; the holiday must not donate.
    const row = run({
      '2026-08-19': cell(0, status('2026-08-19', 'HOLIDAY')),
      '2026-08-20': cell(3, status('2026-08-20', 'WORKING')),
    });
    expect(row.eligibleDays).toBe(1);
    expect(row.payrollDays.find((d) => d.date === '2026-08-19')!.eligible).toBe(false);
  });
});

describe('without a calendar, nothing changes', () => {
  it('falls back to the shift resolver and credits no leave', () => {
    const row = run({ '2026-08-17': cell(9, null) });
    expect(row.holidayDays).toBe(0);
    expect(row.paidLeaveDays).toBe(0);
    expect(row.payrollDays[0]!.leaveUnits).toBe(0);
  });
});
