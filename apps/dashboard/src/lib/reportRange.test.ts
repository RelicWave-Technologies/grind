import { describe, expect, it } from 'vitest';
import {
  addMonths,
  defaultReportMonth,
  defaultReportRange,
  monthRange,
  PAYROLL_CLOSE_DAY,
  stepRange,
  trailingRange,
} from './reportRange';

describe('defaultReportRange', () => {
  it('closes payroll on the 10th', () => {
    expect(PAYROLL_CLOSE_DAY).toBe(10);
  });

  it('shows the whole previous month up to and including the 10th', () => {
    expect(defaultReportRange('2026-10-01')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(defaultReportRange('2026-10-10')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('switches to the current month so far from the 11th', () => {
    expect(defaultReportRange('2026-10-11')).toEqual({ from: '2026-10-01', to: '2026-10-11' });
    expect(defaultReportRange('2026-10-31')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('rolls back over the year boundary in early January', () => {
    expect(defaultReportRange('2027-01-05')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(defaultReportRange('2027-01-10')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(defaultReportRange('2027-01-11')).toEqual({ from: '2027-01-01', to: '2027-01-11' });
  });

  it('ends the previous month on its real last day', () => {
    expect(defaultReportRange('2026-07-03')).toEqual({ from: '2026-06-01', to: '2026-06-30' }); // 30 days
    expect(defaultReportRange('2026-08-09')).toEqual({ from: '2026-07-01', to: '2026-07-31' }); // 31 days
    expect(defaultReportRange('2026-03-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' }); // common Feb
    expect(defaultReportRange('2028-03-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' }); // leap Feb
  });

  it('starts the current month on the 1st, February included', () => {
    expect(defaultReportRange('2028-02-29')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
});

describe('defaultReportMonth', () => {
  it('is the month the default range covers: previous through the 10th, current from the 11th', () => {
    expect(defaultReportMonth('2026-10-10')).toBe('2026-09');
    expect(defaultReportMonth('2026-10-11')).toBe('2026-10');
  });

  it('rolls back to December in early January', () => {
    expect(defaultReportMonth('2027-01-01')).toBe('2026-12');
    expect(defaultReportMonth('2027-01-10')).toBe('2026-12');
    expect(defaultReportMonth('2027-01-11')).toBe('2027-01');
  });
});

describe('monthRange', () => {
  it('is the whole month once it is over', () => {
    expect(monthRange('2026-09', '2026-10-13')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('stops at today while the month is running', () => {
    expect(monthRange('2026-10', '2026-10-13')).toEqual({ from: '2026-10-01', to: '2026-10-13' });
  });

  it('agrees with the default range on either side of the 10th', () => {
    for (const today of ['2026-10-10', '2026-10-11', '2027-01-05', '2027-01-11']) {
      expect(monthRange(defaultReportMonth(today), today)).toEqual(defaultReportRange(today));
    }
  });
});

describe('addMonths', () => {
  it('crosses year boundaries both ways', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(addMonths('2026-10', 0)).toBe('2026-10');
  });
});

describe('stepRange', () => {
  const today = '2026-10-13';

  it('steps whole calendar months for a month span, stopping at today', () => {
    const october = { from: '2026-10-01', to: '2026-10-13' };
    expect(stepRange(october, 'month', -1, today)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(stepRange({ from: '2026-09-01', to: '2026-09-30' }, 'month', 1, today)).toEqual(october);
  });

  it('steps a day span by its length and never past today', () => {
    expect(stepRange(trailingRange(today, 7), 7, -1, today)).toEqual({ from: '2026-09-30', to: '2026-10-06' });
    expect(stepRange({ from: '2026-10-01', to: '2026-10-10' }, 7, 1, today)).toEqual(trailingRange(today, 7));
  });

  it('crosses into the previous year from January', () => {
    expect(stepRange({ from: '2027-01-01', to: '2027-01-11' }, 'month', -1, '2027-01-11')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
});
