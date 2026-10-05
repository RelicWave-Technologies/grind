import { describe, expect, it } from 'vitest';
import { activityPercentOverTrackedMinutes, perTrackedMinute, trackedMinuteCount } from './activityPercent';

describe('activity percent over tracked minutes', () => {
  it('one busy minute in ten tracked minutes is 10%, not 100%', () => {
    expect(activityPercentOverTrackedMinutes(1, { sampledMinutes: 1, trackedMinutes: 10, activeMinutes: 1 })).toBe(10);
  });

  it('counts stored zero-activity minutes when tracked time is unknown', () => {
    expect(activityPercentOverTrackedMinutes(1, { sampledMinutes: 4 })).toBe(25);
    expect(perTrackedMinute(120, { sampledMinutes: 4 })).toBe(30);
  });

  it('never divides by fewer minutes than had activity', () => {
    // Tracked time rounded down at a window edge.
    expect(trackedMinuteCount({ sampledMinutes: 6, trackedMinutes: 4, activeMinutes: 5 })).toBe(5);
    expect(activityPercentOverTrackedMinutes(5, { sampledMinutes: 6, trackedMinutes: 4, activeMinutes: 5 })).toBe(100);
  });

  it('idle minutes stored outside tracked time do not dilute the score', () => {
    // 30 tracked minutes; 10 more zero minutes sampled while the time was later trimmed as idle.
    expect(activityPercentOverTrackedMinutes(15, { sampledMinutes: 40, trackedMinutes: 30, activeMinutes: 20 })).toBe(50);
  });

  it('falls back to stored samples when tracked time is zero or unknown', () => {
    expect(activityPercentOverTrackedMinutes(2, { sampledMinutes: 4, trackedMinutes: 0 })).toBe(50);
    expect(activityPercentOverTrackedMinutes(0, { sampledMinutes: 0 })).toBeNull();
    expect(perTrackedMinute(10, { sampledMinutes: 0 })).toBe(0);
  });
});
