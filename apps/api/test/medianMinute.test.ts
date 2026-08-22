import { describe, it, expect } from 'vitest';
import { medianMinute } from '@grind/types';

const AT = (h: number, m = 0) => h * 60 + m;

describe('medianMinute', () => {
  it('is null when there is nothing to summarise', () => {
    expect(medianMinute([])).toBeNull();
    expect(medianMinute([null, undefined])).toBeNull();
  });

  it('skips days without a punch instead of counting them as midnight', () => {
    expect(medianMinute([null, AT(9), null])).toBe(AT(9));
  });

  it('takes the middle value on odd counts', () => {
    expect(medianMinute([AT(8), AT(9), AT(10)])).toBe(AT(9));
  });

  it('averages the middle pair on even counts, onto a whole minute', () => {
    expect(medianMinute([AT(9, 0), AT(9, 31)])).toBe(AT(9, 16));
  });

  it('resists a single outlier, which is why it is a median and not a mean', () => {
    const days = [AT(3), AT(9), AT(9), AT(9), AT(9)];
    expect(medianMinute(days)).toBe(AT(9));
    const mean = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
    expect(mean).toBe(AT(7, 48)); // the mean would have lied
  });

  it('does not depend on input order', () => {
    expect(medianMinute([AT(18), AT(9), AT(13)])).toBe(AT(13));
  });
});
