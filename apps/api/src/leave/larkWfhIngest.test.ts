import { describe, expect, it } from 'vitest';
import { parseWfhInstance } from './larkWfhIngest';

/**
 * The Lark "Work From Home Request" form, in the shape the instance API returns
 * it. The dates below are lifted from real requests: a one-day request has
 * `start` and `end` on the same IST midnight, a two-day request ends on the
 * midnight that STARTS its second day.
 */
function form(start: string, end: string, interval: number) {
  return JSON.stringify([
    { id: 'widget17449709236910001', name: 'Reason for WFH', type: 'input', ext: null, value: '  Not feeling well  ' },
    {
      id: 'widget17449709306040001',
      name: 'DateInterval',
      type: 'dateInterval',
      ext: null,
      value: { start, end, interval, timezoneOffset: -330 },
    },
  ]);
}

const KOLKATA = 'Asia/Kolkata';

describe('parseWfhInstance', () => {
  it('reads a one-day request as that single IST date', () => {
    const parsed = parseWfhInstance(
      'A',
      {
        status: 'APPROVED',
        open_id: 'ou_x',
        start_time: '1790925638854',
        form: form('2026-09-29T18:30:00Z', '2026-09-29T18:30:00Z', 1),
      },
      KOLKATA,
    );
    expect(parsed).toEqual({
      instanceCode: 'A',
      openId: 'ou_x',
      decision: 'APPROVED',
      startDate: '2026-09-30',
      endDate: '2026-09-30',
      reason: 'Not feeling well',
      appliedAtMs: 1790925638854,
    });
  });

  it('treats the end as inclusive — two days, not three and not one', () => {
    const parsed = parseWfhInstance(
      'B',
      { status: 'PENDING', open_id: 'ou_y', form: form('2026-10-01T18:30:00Z', '2026-10-02T18:30:00Z', 2) },
      KOLKATA,
    );
    expect(parsed?.startDate).toBe('2026-10-02');
    expect(parsed?.endDate).toBe('2026-10-03');
    expect(parsed?.decision).toBe('PENDING');
    expect(parsed?.appliedAtMs).toBeNull();
  });

  it('maps a withdrawn request to CANCELLED', () => {
    const parsed = parseWfhInstance(
      'C',
      { status: 'CANCELED', open_id: 'ou_z', form: form('2026-09-29T18:30:00Z', '2026-09-29T18:30:00Z', 1) },
      KOLKATA,
    );
    expect(parsed?.decision).toBe('CANCELLED');
  });

  it('returns null when the form has no date range', () => {
    expect(parseWfhInstance('D', { status: 'APPROVED', form: '[]' }, KOLKATA)).toBeNull();
    expect(parseWfhInstance('E', { status: 'APPROVED', form: 'not json' }, KOLKATA)).toBeNull();
  });
});
