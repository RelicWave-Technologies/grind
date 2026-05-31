import { describe, it, expect } from 'vitest';
import { buildHeatmap, DEFAULT_BUCKET_MS, type HeatmapSample } from './heatmap';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayStart = new Date('2026-05-30T00:00:00Z').getTime();
const dayEnd = dayStart + DAY_MS;

function sample(minuteOffset: number, m: Partial<HeatmapSample> = {}): HeatmapSample {
  return {
    bucketStartMs: dayStart + minuteOffset * 60_000,
    keystrokes: 0,
    clicks: 0,
    scrollEvents: 0,
    mouseDistancePx: 0,
    isProtectedMeeting: false,
    ...m,
  };
}

describe('buildHeatmap', () => {
  it('empty input → 144 null buckets on a UTC day', () => {
    const r = buildHeatmap({ dayStart, dayEnd, samples: [] });
    expect(r.bucketMs).toBe(DEFAULT_BUCKET_MS);
    expect(r.buckets).toHaveLength(144);
    expect(r.buckets.every((b) => b === null)).toBe(true);
    expect(r.sampleCounts.every((c) => c === 0)).toBe(true);
  });

  it('one heavy-typing minute lands in the right 10-min bucket', () => {
    // Minute 9:00 → bucket index 54 (9h * 6 buckets/h).
    const r = buildHeatmap({
      dayStart,
      dayEnd,
      samples: [sample(9 * 60, { keystrokes: 200, clicks: 30, mouseDistancePx: 5000 })],
    });
    expect(r.buckets[54]).not.toBeNull();
    expect(r.buckets[54]).toBeGreaterThan(0);
    expect(r.sampleCounts[54]).toBe(1);
    // Other buckets stay null.
    expect(r.buckets[0]).toBeNull();
    expect(r.buckets[143]).toBeNull();
  });

  it('idle minute scores 0 — null is reserved for "no samples"', () => {
    const r = buildHeatmap({ dayStart, dayEnd, samples: [sample(9 * 60)] });
    expect(r.buckets[54]).toBe(0);
    expect(r.buckets[55]).toBeNull();
  });

  it('protected meeting minute scores full credit (100)', () => {
    const r = buildHeatmap({
      dayStart,
      dayEnd,
      samples: [sample(10 * 60, { isProtectedMeeting: true })],
    });
    expect(r.buckets[60]).toBe(100);
  });

  it('averages multiple samples in the same bucket', () => {
    // Two heavy minutes back-to-back, both in bucket 54.
    const r = buildHeatmap({
      dayStart,
      dayEnd,
      samples: [
        sample(9 * 60, { keystrokes: 200, clicks: 30, mouseDistancePx: 5000 }),
        sample(9 * 60 + 1, { keystrokes: 0, clicks: 0, mouseDistancePx: 0 }),
      ],
    });
    expect(r.sampleCounts[54]).toBe(2);
    const heavy = buildHeatmap({
      dayStart,
      dayEnd,
      samples: [sample(9 * 60, { keystrokes: 200, clicks: 30, mouseDistancePx: 5000 })],
    });
    // With one idle minute averaged in, the bucket is half the all-heavy bucket.
    expect(r.buckets[54]!).toBeLessThan(heavy.buckets[54]!);
    expect(r.buckets[54]!).toBeGreaterThan(0);
  });

  it('drops samples outside the day window', () => {
    const r = buildHeatmap({
      dayStart,
      dayEnd,
      samples: [
        { ...sample(9 * 60, { keystrokes: 100 }), bucketStartMs: dayStart - 60_000 },
        { ...sample(9 * 60, { keystrokes: 100 }), bucketStartMs: dayEnd + 60_000 },
      ],
    });
    expect(r.buckets.every((b) => b === null)).toBe(true);
  });

  it('respects custom bucketMs', () => {
    // 30-min buckets → 48 cells.
    const r = buildHeatmap({ dayStart, dayEnd, samples: [], bucketMs: 30 * 60_000 });
    expect(r.buckets).toHaveLength(48);
  });

  it('handles a DST short day (23h) by rounding up the grid', () => {
    const shortDayEnd = dayStart + 23 * 60 * 60 * 1000;
    const r = buildHeatmap({ dayStart, dayEnd: shortDayEnd, samples: [] });
    // ceil(23h / 10min) = 138 cells.
    expect(r.buckets).toHaveLength(138);
  });
});
