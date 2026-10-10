import { describe, it, expect } from 'vitest';
import { computeIdleStart } from './decide';

describe('computeIdleStart', () => {
  it('subtracts idle seconds from now', () => {
    expect(computeIdleStart(1_000_000, 60)).toBe(1_000_000 - 60_000);
  });
  it('never goes past now for negative idle', () => {
    expect(computeIdleStart(1_000_000, -5)).toBe(1_000_000);
  });
});
