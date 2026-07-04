import { describe, it, expect } from 'vitest';
import { nextDelayMs } from './scheduler';

describe('nextDelayMs', () => {
  const INT = 180_000; // 3m

  it('returns the exact interval', () => {
    expect(nextDelayMs(INT)).toBe(INT);
  });
  it('rounds fractional milliseconds defensively', () => {
    expect(nextDelayMs(60_000.4)).toBe(60_000);
    expect(nextDelayMs(60_000.5)).toBe(60_001);
  });
  it('enforces a 1s floor on the interval', () => {
    expect(nextDelayMs(0)).toBe(1000);
  });
});
