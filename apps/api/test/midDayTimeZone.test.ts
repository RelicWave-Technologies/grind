import { describe, expect, it } from 'vitest';
import { midDayTimeZone } from './helpers';

/**
 * The overview tests seed work relative to `Date.now()` and assert it lands in
 * "today" as the workspace sees it. That only holds if the lookback never
 * crosses local midnight — which the schema default of UTC does not guarantee.
 * CI proved it at 00:36 UTC, where a 90-minute lookback fell into yesterday and
 * the day's totals came back near zero.
 *
 * The real clock can't be moved to re-check that, so this walks every hour of
 * the day instead.
 */
const LOOKBACK_MS = 120 * 60_000; // comfortably wider than any seeded slot

function localDateKey(at: Date, timeZone: string): string {
  return at.toLocaleDateString('en-CA', { timeZone });
}

describe('midDayTimeZone', () => {
  it('keeps a two-hour lookback inside one local day at every hour of the day', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const now = new Date(Date.UTC(2026, 7, 10, hour, 36, 0));
      const timeZone = midDayTimeZone(now);
      const earliest = new Date(now.getTime() - LOOKBACK_MS);

      expect(
        localDateKey(earliest, timeZone),
        `hour ${hour} in ${timeZone} straddles local midnight`,
      ).toBe(localDateKey(now, timeZone));
    }
  });

  it('puts the current instant around the middle of the local day', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const now = new Date(Date.UTC(2026, 7, 10, hour, 0, 0));
      const localHour = Number(
        now.toLocaleString('en-GB', { timeZone: midDayTimeZone(now), hour: '2-digit', hour12: false }),
      );
      expect(localHour, `hour ${hour} landed at local ${localHour}`).toBe(12);
    }
  });

  it('names a real, resolvable zone', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const timeZone = midDayTimeZone(new Date(Date.UTC(2026, 7, 10, hour)));
      expect(() => new Intl.DateTimeFormat('en', { timeZone })).not.toThrow();
    }
  });
});
