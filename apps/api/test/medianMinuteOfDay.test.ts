import { describe, it, expect } from 'vitest';
import { medianMinuteOfDay, minuteOfDayInTimeZone } from '@grind/types';

/** 2026-06-01 at the given UTC hour/minute. */
function utc(hour: number, minute = 0): number {
  return Date.UTC(2026, 5, 1, hour, minute);
}

describe('minuteOfDayInTimeZone', () => {
  it('projects an instant into the target zone, not UTC', () => {
    // 03:30 UTC is 09:00 in Kolkata (+05:30).
    expect(minuteOfDayInTimeZone(utc(3, 30), 'Asia/Kolkata')).toBe(9 * 60);
    expect(minuteOfDayInTimeZone(utc(3, 30), 'UTC')).toBe(3 * 60 + 30);
  });

  it('normalises local midnight to 0 rather than 1440', () => {
    expect(minuteOfDayInTimeZone(utc(18, 30), 'Asia/Kolkata')).toBe(0);
  });
});

describe('medianMinuteOfDay', () => {
  it('is null when there is nothing to summarise', () => {
    expect(medianMinuteOfDay([], 'UTC')).toBeNull();
    expect(medianMinuteOfDay([null, null], 'UTC')).toBeNull();
  });

  it('ignores days without a punch instead of counting them as midnight', () => {
    expect(medianMinuteOfDay([null, utc(9), null], 'UTC')).toBe(9 * 60);
  });

  it('takes the middle value on odd counts', () => {
    expect(medianMinuteOfDay([utc(8), utc(9), utc(10)], 'UTC')).toBe(9 * 60);
  });

  it('averages the middle pair on even counts, onto a whole minute', () => {
    // 09:00 and 09:31 -> 09:15.5 -> rounds to 09:16.
    expect(medianMinuteOfDay([utc(9, 0), utc(9, 31)], 'UTC')).toBe(9 * 60 + 16);
  });

  it('resists a single outlier, which is why it is a median and not a mean', () => {
    // Four 09:00 starts and one 03:00 deploy night.
    const days = [utc(3), utc(9), utc(9), utc(9), utc(9)];
    expect(medianMinuteOfDay(days, 'UTC')).toBe(9 * 60);
    const mean = days.reduce((a, b) => a + minuteOfDayInTimeZone(b, 'UTC'), 0) / days.length;
    expect(Math.round(mean)).toBe(7 * 60 + 48); // the mean would have lied
  });

  it('does not depend on input order', () => {
    expect(medianMinuteOfDay([utc(18), utc(9), utc(13)], 'UTC')).toBe(13 * 60);
  });
});
