import { describe, it, expect } from 'vitest';
import { activityPercent, KEYS_SAT_PER_MIN, CLICKS_SAT_PER_MIN } from './percent';

describe('activityPercent', () => {
  it('is zero for an empty window', () => {
    expect(activityPercent({ minutes: 0, keystrokes: 0, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 })).toEqual({ keyboard: 0, mouse: 0 });
  });

  it('maps saturation rate to 100%', () => {
    const w = { minutes: 2, keystrokes: KEYS_SAT_PER_MIN * 2, clicks: CLICKS_SAT_PER_MIN * 2, mouseDistancePx: 0, scrollEvents: 0 };
    const r = activityPercent(w);
    expect(r.keyboard).toBe(100);
    expect(r.mouse).toBe(100);
  });

  it('clamps above saturation to 100', () => {
    const r = activityPercent({ minutes: 1, keystrokes: 100000, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 });
    expect(r.keyboard).toBe(100);
  });

  it('half-saturation reads ~50%', () => {
    const r = activityPercent({ minutes: 1, keystrokes: KEYS_SAT_PER_MIN / 2, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 });
    expect(r.keyboard).toBe(50);
    expect(r.mouse).toBe(0);
  });

  it('mouse uses the busiest channel (movement alone counts)', () => {
    const r = activityPercent({ minutes: 1, keystrokes: 0, clicks: 0, mouseDistancePx: 6000, scrollEvents: 0 });
    expect(r.mouse).toBe(100);
    expect(r.keyboard).toBe(0);
  });

  it('averages over the window minutes', () => {
    // 120 keys over 2 minutes = 60/min = half of 120 saturation → 50%
    const r = activityPercent({ minutes: 2, keystrokes: 120, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 });
    expect(r.keyboard).toBe(50);
  });
});
