import { describe, expect, it } from 'vitest';
import { restartDidNotHelp } from './permissionRelaunch';

const record = { verdict: ['screen:FAILED', 'accessibility:NEEDS_GRANT'], relaunchedAt: 0 };

describe('restartDidNotHelp', () => {
  it('is true when the verdict a restart was tried for came straight back', () => {
    expect(restartDidNotHelp(record, 'screen', 'FAILED')).toBe(true);
    expect(restartDidNotHelp(record, 'accessibility', 'NEEDS_GRANT')).toBe(true);
  });

  it('is false for a different verdict, a ready capability, or no restart at all', () => {
    expect(restartDidNotHelp(record, 'screen', 'NEEDS_SETTINGS')).toBe(false);
    expect(restartDidNotHelp(record, 'accessibility', 'FAILED')).toBe(false);
    expect(restartDidNotHelp(record, 'screen', 'READY')).toBe(false);
    expect(restartDidNotHelp(null, 'screen', 'FAILED')).toBe(false);
  });

  it('waits out CHECKING: the screen re-verifies after every boot', () => {
    expect(restartDidNotHelp({ verdict: ['screen:CHECKING'], relaunchedAt: 0 }, 'screen', 'CHECKING')).toBe(false);
  });
});
