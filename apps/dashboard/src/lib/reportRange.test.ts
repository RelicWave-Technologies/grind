import { describe, expect, it } from 'vitest';
import { defaultReportRange, PAYROLL_CLOSE_DAY } from './reportRange';

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
