import { describe, expect, it } from 'vitest';
import { resolveTodayLedgerMode } from '../src/agent/todayLedgerMode';

describe('resolveTodayLedgerMode', () => {
  it('keeps hydration off regardless of the canary list', () => {
    expect(resolveTodayLedgerMode('OFF', 'user-1', 'user-1')).toBe('OFF');
  });

  it('applies a configured mode globally when no canary list exists', () => {
    expect(resolveTodayLedgerMode('SHADOW', undefined, 'user-1')).toBe('SHADOW');
  });

  it('applies a configured mode only to listed canary users', () => {
    expect(resolveTodayLedgerMode('VISIBLE', ' user-1, user-2 ', 'user-2')).toBe('VISIBLE');
    expect(resolveTodayLedgerMode('VISIBLE', ' user-1, user-2 ', 'user-3')).toBe('OFF');
  });
});
