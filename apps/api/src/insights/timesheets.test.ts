import { describe, it, expect } from 'vitest';
import { addDays } from '@grind/types';
import { dateRange } from './timesheets';

describe('dateRange + addDays', () => {
  it('addDays handles month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('dateRange is inclusive on both ends', () => {
    expect(dateRange('2026-05-25', '2026-05-27')).toEqual(['2026-05-25', '2026-05-26', '2026-05-27']);
  });
  it('dateRange single-day collapses to one entry', () => {
    expect(dateRange('2026-05-25', '2026-05-25')).toEqual(['2026-05-25']);
  });
});
