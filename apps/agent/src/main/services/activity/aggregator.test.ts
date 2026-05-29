import { describe, it, expect } from 'vitest';
import { ActivityAggregator, coefficientOfVariation } from './aggregator';

describe('coefficientOfVariation', () => {
  it('is null for <2 values', () => {
    expect(coefficientOfVariation([])).toBeNull();
    expect(coefficientOfVariation([5])).toBeNull();
  });
  it('is ~0 for perfectly regular (metronomic) values', () => {
    const cv = coefficientOfVariation([100, 100, 100, 100])!;
    expect(cv).toBeCloseTo(0, 6);
  });
  it('is higher for irregular (bursty) values', () => {
    const cv = coefficientOfVariation([10, 400, 30, 600, 20])!;
    expect(cv).toBeGreaterThan(0.5);
  });
  it('is null when mean is 0', () => {
    expect(coefficientOfVariation([0, 0, 0])).toBeNull();
  });
});

describe('ActivityAggregator counts', () => {
  it('counts keystrokes, clicks, scrolls', () => {
    const a = new ActivityAggregator();
    a.onKey(0); a.onKey(100); a.onClick(); a.onClick(); a.onScroll();
    const s = a.flush(1000);
    expect(s).toMatchObject({ bucketStart: 1000, keystrokes: 2, clicks: 2, scrollEvents: 1 });
  });

  it('accumulates mouse distance across moves', () => {
    const a = new ActivityAggregator();
    a.onMove(0, 0, 0);
    a.onMove(10, 3, 4); // dist 5
    a.onMove(20, 6, 8); // dist 5
    const s = a.flush(0);
    expect(s.mouseDistancePx).toBe(10);
  });

  it('resets after flush', () => {
    const a = new ActivityAggregator();
    a.onKey(0); a.onClick();
    a.flush(0);
    const s = a.flush(60000);
    expect(s).toMatchObject({ keystrokes: 0, clicks: 0, scrollEvents: 0, mouseDistancePx: 0 });
    expect(a.isEmpty()).toBe(true);
  });
});

describe('ActivityAggregator timing CVs (anti-cheat signals)', () => {
  it('metronomic typing → ikiCv ≈ 0 (bot signature)', () => {
    const a = new ActivityAggregator();
    for (let t = 0; t <= 1000; t += 100) a.onKey(t); // exact 100ms gaps
    const s = a.flush(0);
    expect(s.ikiCv).not.toBeNull();
    expect(s.ikiCv!).toBeLessThan(0.01);
  });

  it('bursty human typing → high ikiCv', () => {
    const a = new ActivityAggregator();
    [0, 80, 130, 600, 660, 1400, 1450].forEach((t) => a.onKey(t));
    const s = a.flush(0);
    expect(s.ikiCv!).toBeGreaterThan(0.4);
  });

  it('ikiCv null with fewer than 3 keystrokes', () => {
    const a = new ActivityAggregator();
    a.onKey(0); a.onKey(100);
    expect(a.flush(0).ikiCv).toBeNull();
  });

  it('straight-line constant-velocity mouse → straightness ≈ 1, moveSpeedCv ≈ 0 (bot)', () => {
    const a = new ActivityAggregator();
    for (let i = 0; i <= 10; i++) a.onMove(i * 10, i * 5, 0); // straight, constant speed
    const s = a.flush(0);
    expect(s.pathStraightness!).toBeCloseTo(1, 4);
    expect(s.moveSpeedCv!).toBeLessThan(0.01);
  });

  it('wandering human mouse → straightness < 1', () => {
    const a = new ActivityAggregator();
    a.onMove(0, 0, 0);
    a.onMove(10, 50, 0);
    a.onMove(20, 50, 50);
    a.onMove(30, 0, 50);
    a.onMove(40, 0, 0); // returns near start → low straightness
    const s = a.flush(0);
    expect(s.pathStraightness!).toBeLessThan(0.2);
  });

  it('pathStraightness null with no movement', () => {
    const a = new ActivityAggregator();
    a.onKey(0);
    expect(a.flush(0).pathStraightness).toBeNull();
  });
});
