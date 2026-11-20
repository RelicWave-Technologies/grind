import { describe, expect, it } from 'vitest';
import { fmtMinuteOfDay, fmtTime } from './format';

describe('clock formatters use the 12h clock', () => {
  it('shows an evening punch out as 7:43 PM, not 19:43', () => {
    expect(fmtMinuteOfDay(19 * 60 + 43)).toMatch(/^7:43\s?pm$/iu);
    expect(fmtMinuteOfDay(9 * 60 + 5)).toMatch(/^9:05\s?am$/iu);
    expect(fmtMinuteOfDay(0)).toMatch(/^12:00\s?am$/iu);
  });

  it('shows an instant on the 12h clock in the given zone', () => {
    expect(fmtTime(Date.UTC(2026, 10, 20, 13, 13), 'Asia/Kolkata')).toMatch(/^6:43\s?pm$/iu);
  });
});
