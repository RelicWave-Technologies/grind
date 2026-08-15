import { describe, it, expect } from 'vitest';
import {
  CAPTURE_DEFER_MS,
  CAPTURE_QUIET_SECONDS,
  MAX_CAPTURE_DEFERRALS,
  nextDelayMs,
  shouldDeferCapture,
} from './scheduler';

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

describe('shouldDeferCapture', () => {
  it('waits for a gap in input, because the stall freezes every window', () => {
    // Measured: ~290ms in desktopCapturer on the process that owns the timer
    // bar, the prompts and the main window.
    expect(shouldDeferCapture(0, 0)).toBe(true);
    expect(shouldDeferCapture(1, 0)).toBe(true);
  });

  it('goes ahead once input has been quiet', () => {
    expect(shouldDeferCapture(CAPTURE_QUIET_SECONDS, 0)).toBe(false);
    expect(shouldDeferCapture(30, 0)).toBe(false);
  });

  it('never holds a capture back forever', () => {
    // Someone typing continuously must still be captured — silently dropping
    // their screenshots would be a worse bug than a brief stutter.
    expect(shouldDeferCapture(0, MAX_CAPTURE_DEFERRALS - 1)).toBe(true);
    expect(shouldDeferCapture(0, MAX_CAPTURE_DEFERRALS)).toBe(false);
    expect(shouldDeferCapture(0, MAX_CAPTURE_DEFERRALS + 5)).toBe(false);
  });

  it('bounds the total delay it can add', () => {
    expect(MAX_CAPTURE_DEFERRALS * CAPTURE_DEFER_MS).toBeLessThanOrEqual(10_000);
  });
});
