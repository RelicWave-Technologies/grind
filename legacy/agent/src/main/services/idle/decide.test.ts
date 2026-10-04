import { describe, it, expect } from 'vitest';
import { shouldPromptIdle, computeIdleStart } from './decide';

const base = { isRunning: true, idleSeconds: 0, thresholdSec: 300, prompting: false };

describe('shouldPromptIdle', () => {
  it('prompts when running, over threshold, not already prompting', () => {
    expect(shouldPromptIdle({ ...base, idleSeconds: 301 })).toBe(true);
    expect(shouldPromptIdle({ ...base, idleSeconds: 300 })).toBe(true);
  });
  it('does not prompt below threshold', () => {
    expect(shouldPromptIdle({ ...base, idleSeconds: 120 })).toBe(false);
  });
  it('does not prompt when not running', () => {
    expect(shouldPromptIdle({ ...base, isRunning: false, idleSeconds: 999 })).toBe(false);
  });
  it('does not prompt when already prompting', () => {
    expect(shouldPromptIdle({ ...base, idleSeconds: 999, prompting: true })).toBe(false);
  });
});

describe('computeIdleStart', () => {
  it('subtracts idle seconds from now', () => {
    expect(computeIdleStart(1_000_000, 60)).toBe(1_000_000 - 60_000);
  });
  it('never goes past now for negative idle', () => {
    expect(computeIdleStart(1_000_000, -5)).toBe(1_000_000);
  });
});
