import { describe, it, expect } from 'vitest';
import { possibleInstantsForZonedDateTime } from '@grind/types';
import { instantForLocalMinute } from './shift';

/**
 * Wall-clock resolution is memoised in @grind/types. A cached answer must be
 * the same answer, every time, including the DST edge cases, and callers must
 * get Dates they can mutate without poisoning the cache.
 */
describe('memoised wall-clock resolution', () => {
  const ny = 'America/New_York';

  it('answers repeat calls identically, including fall-back and spring-forward', () => {
    const fallBack = { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 };
    const gap = { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 };
    const plain = { year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0 };
    for (let i = 0; i < 3; i += 1) {
      expect(possibleInstantsForZonedDateTime(fallBack, ny).map((d) => d.toISOString())).toEqual([
        '2026-11-01T05:30:00.000Z',
        '2026-11-01T06:30:00.000Z',
      ]);
      expect(possibleInstantsForZonedDateTime(gap, ny)).toEqual([]);
      expect(possibleInstantsForZonedDateTime(plain, ny).map((d) => d.toISOString())).toEqual(['2026-10-12T13:00:00.000Z']);
      // Skipped clock resolves to the first instant after the gap.
      expect(instantForLocalMinute('2026-03-08', 150, ny)).toBe(Date.parse('2026-03-08T07:00:00.000Z'));
      expect(instantForLocalMinute('2026-10-12', 9 * 60 + 15, 'Asia/Kolkata')).toBe(Date.parse('2026-10-12T03:45:00.000Z'));
    }
  });

  it('hands out fresh Date objects', () => {
    const parts = { year: 2026, month: 10, day: 12, hour: 10, minute: 0, second: 0 };
    const first = possibleInstantsForZonedDateTime(parts, ny);
    first[0]!.setTime(0);
    expect(possibleInstantsForZonedDateTime(parts, ny)[0]!.toISOString()).toBe('2026-10-12T14:00:00.000Z');
  });

  it('still rejects an impossible clock', () => {
    expect(() => possibleInstantsForZonedDateTime({ year: 2026, month: 2, day: 30, hour: 0, minute: 0, second: 0 }, ny)).toThrow();
    expect(() => possibleInstantsForZonedDateTime({ year: 2026, month: 2, day: 30, hour: 0, minute: 0, second: 0 }, ny)).toThrow();
  });
});
