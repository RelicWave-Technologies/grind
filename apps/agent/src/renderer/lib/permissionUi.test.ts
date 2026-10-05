import { describe, it, expect } from 'vitest';
import { actionFor, actionLabel, isReady, offersRestart, statusText } from './permissionUi';

const fresh = { checkedAgain: false, returnedFromSettings: false };

describe('permission prompt copy and actions', () => {
  it('offers the system prompt when a grant was never requested', () => {
    expect(actionFor('NEEDS_GRANT')).toBe('enable');
  });

  it('sends a denied capability to System Settings', () => {
    expect(actionFor('NEEDS_SETTINGS')).toBe('settings');
    expect(statusText('NEEDS_SETTINGS', 'screen')).toBe('Enable in System Settings');
  });

  it('points a refused input hook at Accessibility, never Input Monitoring', () => {
    // libuiohook's active tap is gated on Accessibility trust; Timo never
    // requests Input Monitoring. A trusted-but-refused hook means stale trust.
    expect(actionFor('FAILED')).toBe('check-again');
    expect(statusText('FAILED', 'accessibility')).toBe('Not responding — turn Timo off and on under Accessibility');
    expect(statusText('FAILED', 'accessibility')).not.toMatch(/input monitoring/i);
  });

  it('offers a check, not a restart, for a granted screen that stays blank', () => {
    expect(actionFor('FAILED')).toBe('check-again');
    expect(statusText('FAILED', 'screen')).not.toMatch(/restart/i);
    expect(actionLabel('check-again')).toBe('Check again');
    expect(offersRestart('FAILED', 'screen', fresh)).toBe(false);
  });

  it('adds Restart Timo for FAILED only once Check again has not helped', () => {
    expect(offersRestart('FAILED', 'accessibility', fresh)).toBe(false);
    expect(offersRestart('FAILED', 'accessibility', { ...fresh, checkedAgain: true })).toBe(true);
    expect(offersRestart('FAILED', 'screen', { ...fresh, checkedAgain: true })).toBe(true);
  });

  it('adds Restart Timo when the screen is still not granted after System Settings', () => {
    // A grant made while Timo runs can read as missing until relaunch.
    const back = { ...fresh, returnedFromSettings: true };
    expect(offersRestart('NEEDS_SETTINGS', 'screen', fresh)).toBe(false);
    expect(offersRestart('NEEDS_SETTINGS', 'screen', back)).toBe(true);
    expect(offersRestart('NEEDS_GRANT', 'screen', back)).toBe(true);
    // Accessibility trust is read live; a restart adds nothing there.
    expect(offersRestart('NEEDS_SETTINGS', 'accessibility', back)).toBe(false);
  });

  it('never offers a restart while a granted screen is still being checked', () => {
    expect(actionFor('CHECKING')).toBeNull();
    expect(statusText('CHECKING', 'screen')).toBe('Checking…');
    expect(offersRestart('CHECKING', 'screen', { checkedAgain: true, returnedFromSettings: true })).toBe(false);
  });

  it('offers nothing once a capability is satisfied', () => {
    expect(actionFor('READY')).toBeNull();
    expect(actionFor('NOT_REQUIRED')).toBeNull();
    expect(offersRestart('READY', 'screen', { checkedAgain: true, returnedFromSettings: true })).toBe(false);
    // NOT_REQUIRED is the Windows/Linux answer — it must read as fine, not as a
    // blocker, since neither platform gates screen capture or input hooks.
    expect(isReady('NOT_REQUIRED')).toBe(true);
    expect(statusText('NOT_REQUIRED', 'screen')).toBe('Ready');
  });
});
