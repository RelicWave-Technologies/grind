import { describe, it, expect } from 'vitest';
import { nextDelayMs } from './scheduler';

describe('nextDelayMs', () => {
  const INT = 3_600_000; // 1h

  it('returns half the interval at rng=0', () => {
    expect(nextDelayMs(INT, () => 0)).toBe(INT / 2);
  });
  it('returns the full interval at rng=1', () => {
    expect(nextDelayMs(INT, () => 1)).toBe(INT);
  });
  it('stays within [interval/2, interval] for random rng', () => {
    for (let i = 0; i < 100; i++) {
      const d = nextDelayMs(INT, Math.random);
      expect(d).toBeGreaterThanOrEqual(INT / 2);
      expect(d).toBeLessThanOrEqual(INT);
    }
  });
  it('clamps out-of-range rng', () => {
    expect(nextDelayMs(INT, () => -5)).toBe(INT / 2);
    expect(nextDelayMs(INT, () => 9)).toBe(INT);
  });
  it('enforces a 1s floor on the interval', () => {
    expect(nextDelayMs(0, () => 0)).toBe(500);
  });
});
