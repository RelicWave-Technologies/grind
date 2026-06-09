import { describe, it, expect } from 'vitest';
import { buildMonthlyPayroll, formatPayrollCsv } from './monthly';
import type { TimesheetMatrix } from '../insights/timesheets';

const HOUR = 60 * 60 * 1000;

const u = (id: string, name: string, team: string | null = null) => ({
  id,
  name,
  email: `${name.toLowerCase().replace(/\s/g, '.')}@x.com`,
  role: 'MEMBER',
  teamId: team ? `t_${team}` : null,
  teamName: team,
});

const cell = (workedH: number, meetingH = 0, manualH = 0) => ({
  workedMs: workedH * HOUR,
  meetingMs: meetingH * HOUR,
  manualMs: manualH * HOUR,
  totalMs: (workedH + meetingH + manualH) * HOUR,
  firstActivityMs: null,
  lastActivityMs: null,
});

function emptyMatrix(days: string[]): TimesheetMatrix {
  return { from: days[0]!, to: days[days.length - 1]!, tz: 'UTC', days, cells: {} };
}

const NOW = 1_700_000_000_000;
const workingSchedule = {
  sun: null,
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: null,
};

const shift = () => ({
  shiftId: 'shift-1',
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  effectiveTo: null,
  shiftNameSnapshot: 'General',
  scheduleSnapshot: workingSchedule,
});

describe('buildMonthlyPayroll', () => {
  it('returns empty rows + zero totals when there are no users', () => {
    const p = buildMonthlyPayroll(
      { month: '2026-05', tz: 'UTC', matrix: emptyMatrix(['2026-05-01']), users: [] },
      NOW,
    );
    expect(p.rows).toEqual([]);
    expect(p.totals).toMatchObject({
      daysPresent: 0,
      workedHours: 0,
      meetingHours: 0,
      manualHours: 0,
      totalHours: 0,
    });
    expect(p.month).toBe('2026-05');
    expect(p.tz).toBe('UTC');
    expect(p.generatedAtMs).toBe(NOW);
  });

  it('zero days present + zero hours when a user has no cells', () => {
    const p = buildMonthlyPayroll(
      {
        month: '2026-05',
        tz: 'UTC',
        matrix: emptyMatrix(['2026-05-01', '2026-05-02']),
        users: [u('u1', 'Alice')],
      },
      NOW,
    );
    expect(p.rows[0]?.daysPresent).toBe(0);
    expect(p.rows[0]?.totalHours).toBe(0);
    expect(p.rows[0]?.avgDayHours).toBe(0);
  });

  it('sums worked + meeting + manual hours across days', () => {
    const days = ['2026-05-01', '2026-05-02', '2026-05-03'];
    const m: TimesheetMatrix = {
      ...emptyMatrix(days),
      cells: {
        u1: {
          '2026-05-01': cell(8, 1, 0), // 9h
          '2026-05-02': cell(6, 2, 1), // 9h
          '2026-05-03': cell(0, 0, 4), // 4h
        },
      },
    };
    const p = buildMonthlyPayroll(
      { month: '2026-05', tz: 'UTC', matrix: m, users: [u('u1', 'Alice')] },
      NOW,
    );
    expect(p.rows[0]?.workedHours).toBe(14);
    expect(p.rows[0]?.meetingHours).toBe(3);
    expect(p.rows[0]?.manualHours).toBe(5);
    expect(p.rows[0]?.totalHours).toBe(22);
    expect(p.rows[0]?.daysPresent).toBe(3);
    expect(p.rows[0]?.avgDayHours).toBeCloseTo(22 / 3, 2);
  });

  it('counts a day with only manual time as present', () => {
    const days = ['2026-05-01', '2026-05-02'];
    const m: TimesheetMatrix = {
      ...emptyMatrix(days),
      cells: {
        u1: {
          '2026-05-01': cell(0, 0, 2),
        },
      },
    };
    const p = buildMonthlyPayroll(
      { month: '2026-05', tz: 'UTC', matrix: m, users: [u('u1', 'Alice')] },
      NOW,
    );
    expect(p.rows[0]?.daysPresent).toBe(1);
  });

  it('sorts rows by totalHours desc; ties broken on name', () => {
    const days = ['2026-05-01'];
    const m: TimesheetMatrix = {
      ...emptyMatrix(days),
      cells: {
        a: { '2026-05-01': cell(3) },
        b: { '2026-05-01': cell(3) },
        c: { '2026-05-01': cell(8) },
      },
    };
    const p = buildMonthlyPayroll(
      {
        month: '2026-05',
        tz: 'UTC',
        matrix: m,
        users: [u('b', 'Bob'), u('a', 'Alice'), u('c', 'Carol')],
      },
      NOW,
    );
    expect(p.rows.map((r) => r.user.id)).toEqual(['c', 'a', 'b']);
  });

  it('aggregates totals across all users', () => {
    const days = ['2026-05-01', '2026-05-02'];
    const m: TimesheetMatrix = {
      ...emptyMatrix(days),
      cells: {
        u1: { '2026-05-01': cell(8, 1, 0), '2026-05-02': cell(8, 1, 0) },
        u2: { '2026-05-01': cell(4, 0, 0) },
      },
    };
    const p = buildMonthlyPayroll(
      { month: '2026-05', tz: 'UTC', matrix: m, users: [u('u1', 'A'), u('u2', 'B')] },
      NOW,
    );
    expect(p.totals.workedHours).toBe(20);
    expect(p.totals.meetingHours).toBe(2);
    expect(p.totals.daysPresent).toBe(3);
    expect(p.totals.totalHours).toBe(22);
  });

  it('does not mutate the input matrix', () => {
    const m: TimesheetMatrix = {
      ...emptyMatrix(['2026-05-01']),
      cells: { u1: { '2026-05-01': cell(8) } },
    };
    const snapshot = JSON.stringify(m);
    buildMonthlyPayroll(
      { month: '2026-05', tz: 'UTC', matrix: m, users: [u('u1', 'A')] },
      NOW,
    );
    expect(JSON.stringify(m)).toBe(snapshot);
  });

  it('monthly guarantee marks every eligible shift day full', () => {
    const days = ['2026-05-04', '2026-05-05'];
    const m: TimesheetMatrix = {
      ...emptyMatrix(days),
      cells: { u1: { '2026-05-04': cell(1), '2026-05-05': cell(1) } },
    };
    const p = buildMonthlyPayroll(
      {
        month: '2026-05',
        tz: 'UTC',
        matrix: m,
        users: [u('u1', 'Alice')],
        policy: {
          halfDayLowerMin: 240,
          halfDayUpperMin: 480,
          fullDayLowerMin: 480,
          fullDayUpperMin: 600,
          monthlyLowerMin: 60,
        },
        shiftAssignments: { u1: [shift()] },
      },
      NOW,
    );
    expect(p.rows[0]?.monthlyGuarantee).toBe(true);
    expect(p.rows[0]?.payrollDays.map((d) => d.status)).toEqual(['FULL', 'FULL']);
    expect(p.rows[0]?.payableUnits).toBe(2);
  });

  it('caps overflow above the full-day upper limit', () => {
    const days = ['2026-05-04'];
    const m: TimesheetMatrix = {
      ...emptyMatrix(days),
      cells: { u1: { '2026-05-04': cell(12) } },
    };
    const p = buildMonthlyPayroll(
      {
        month: '2026-05',
        tz: 'UTC',
        matrix: m,
        users: [u('u1', 'Alice')],
        policy: {
          halfDayLowerMin: 240,
          halfDayUpperMin: 480,
          fullDayLowerMin: 480,
          fullDayUpperMin: 600,
          monthlyLowerMin: 9_999,
        },
        shiftAssignments: { u1: [shift()] },
      },
      NOW,
    );
    expect(p.rows[0]?.rawHours).toBe(12);
    expect(p.rows[0]?.cappedHours).toBe(10);
    expect(p.rows[0]?.ignoredOverflowHours).toBe(2);
    expect(p.rows[0]?.fullDays).toBe(1);
  });

  it('excludes scheduled-off and no-shift days from payroll Off', () => {
    const days = ['2026-05-02', '2026-05-04']; // Sat + Mon
    const m: TimesheetMatrix = {
      ...emptyMatrix(days),
      cells: { u1: { '2026-05-02': cell(2), '2026-05-04': cell(0) }, u2: { '2026-05-04': cell(1) } },
    };
    const p = buildMonthlyPayroll(
      { month: '2026-05', tz: 'UTC', matrix: m, users: [u('u1', 'Alice'), u('u2', 'Bob')], shiftAssignments: { u1: [shift()] } },
      NOW,
    );
    const alice = p.rows.find((r) => r.user.id === 'u1')!;
    const bob = p.rows.find((r) => r.user.id === 'u2')!;
    expect(alice.scheduledOffDays).toBe(1);
    expect(alice.offDays).toBe(1);
    expect(bob.noShiftDays).toBe(2);
    expect(bob.offDays).toBe(0);
  });

  it('carries short-day credit only in the payroll ledger', () => {
    const days = ['2026-05-04', '2026-05-05'];
    const m: TimesheetMatrix = {
      ...emptyMatrix(days),
      cells: { u1: { '2026-05-04': cell(9), '2026-05-05': cell(3) } },
    };
    const p = buildMonthlyPayroll(
      {
        month: '2026-05',
        tz: 'UTC',
        matrix: m,
        users: [u('u1', 'Alice')],
        policy: {
          halfDayLowerMin: 240,
          halfDayUpperMin: 480,
          fullDayLowerMin: 480,
          fullDayUpperMin: 600,
          monthlyLowerMin: 9_999,
        },
        shiftAssignments: { u1: [shift()] },
      },
      NOW,
    );
    expect(p.rows[0]?.payrollDays.map((d) => d.status)).toEqual(['FULL', 'HALF']);
    expect(p.rows[0]?.carryLedger).toHaveLength(2);
    expect(p.rows[0]?.totalHours).toBe(12);
    expect(p.rows[0]?.payableUnits).toBe(1.5);
  });
});

describe('formatPayrollCsv', () => {
  it('emits header + per-user row + TOTAL line', () => {
    const m: TimesheetMatrix = {
      ...emptyMatrix(['2026-05-01']),
      cells: { u1: { '2026-05-01': cell(8) } },
    };
    const p = buildMonthlyPayroll(
      { month: '2026-05', tz: 'UTC', matrix: m, users: [u('u1', 'Alice')] },
      NOW,
    );
    const csv = formatPayrollCsv(p);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3); // header + 1 user + total
    expect(lines[0]).toContain('Name');
    expect(lines[1]).toContain('Alice');
    expect(lines[2]).toContain('TOTAL');
  });

  it('quotes names with commas', () => {
    const m: TimesheetMatrix = {
      ...emptyMatrix(['2026-05-01']),
      cells: { u1: { '2026-05-01': cell(1) } },
    };
    const p = buildMonthlyPayroll(
      {
        month: '2026-05',
        tz: 'UTC',
        matrix: m,
        users: [{ ...u('u1', 'Smith, Jr.'), name: 'Smith, Jr.' }],
      },
      NOW,
    );
    const csv = formatPayrollCsv(p);
    expect(csv).toContain('"Smith, Jr."');
  });

  it('escapes embedded quotes by doubling them', () => {
    const m: TimesheetMatrix = {
      ...emptyMatrix(['2026-05-01']),
      cells: { u1: { '2026-05-01': cell(1) } },
    };
    const p = buildMonthlyPayroll(
      {
        month: '2026-05',
        tz: 'UTC',
        matrix: m,
        users: [{ ...u('u1', 'Q'), name: 'Q "QQ" Q' }],
      },
      NOW,
    );
    const csv = formatPayrollCsv(p);
    expect(csv).toContain('"Q ""QQ"" Q"');
  });
});
