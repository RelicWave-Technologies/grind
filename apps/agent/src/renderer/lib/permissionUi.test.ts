import { describe, it, expect } from 'vitest';
import { actionFor, actionLabel, isReady, statusText } from './permissionUi';

describe('permission prompt copy and actions', () => {
  it('offers the system prompt when a grant was never requested', () => {
    expect(actionFor('NEEDS_GRANT', 'screen')).toBe('enable');
    expect(actionFor('NEEDS_GRANT', 'accessibility')).toBe('enable');
  });

  it('sends a denied capability to System Settings', () => {
    expect(actionFor('NEEDS_SETTINGS', 'screen')).toBe('settings');
    expect(statusText('NEEDS_SETTINGS', 'screen')).toBe('Enable in System Settings');
  });

  it('points a refused input hook at Input Monitoring, not a restart', () => {
    // Accessibility trusted but the CGEventTap was refused. Input Monitoring is
    // a different TCC service; restarting can never supply it, so neither the
    // button nor the copy may suggest that.
    expect(actionFor('FAILED', 'accessibility')).toBe('input-monitoring');
    expect(statusText('FAILED', 'accessibility')).toBe('Also allow Timo under Input Monitoring');
  });

  it('never offers a restart for Accessibility FAILED on either surface', () => {
    // Settings used to keep its own mapping and offered "Restart Timo" here,
    // contradicting the prompt. Both now read this function.
    expect(actionFor('FAILED', 'accessibility', true)).toBe('input-monitoring');
    expect(statusText('FAILED', 'accessibility')).not.toMatch(/restart/i);
  });

  it('offers a check, not a restart, for a granted screen that stays blank', () => {
    expect(actionFor('FAILED', 'screen')).toBe('check-again');
    expect(statusText('FAILED', 'screen')).not.toMatch(/restart/i);
    expect(actionLabel('check-again')).toBe('Check again');
  });

  it('offers nothing while a capability is still being verified', () => {
    expect(actionFor('CHECKING', 'screen')).toBeNull();
    expect(statusText('CHECKING', 'screen')).toBe('Checking…');
  });

  it('offers a restart once, then a check if the same verdict survives it', () => {
    expect(actionFor('NEEDS_RESTART', 'accessibility')).toBe('restart');
    expect(statusText('NEEDS_RESTART', 'accessibility')).toBe('Restart Timo to apply');

    expect(actionFor('NEEDS_RESTART', 'accessibility', true)).toBe('check-again');
    expect(statusText('NEEDS_RESTART', 'accessibility', true)).toBe('Still not ready after restart');
  });

  it('offers nothing once a capability is satisfied', () => {
    expect(actionFor('READY', 'screen')).toBeNull();
    expect(actionFor('NOT_REQUIRED', 'accessibility')).toBeNull();
    // NOT_REQUIRED is the Windows/Linux answer — it must read as fine, not as a
    // blocker, since neither platform gates screen capture or input hooks.
    expect(isReady('NOT_REQUIRED')).toBe(true);
    expect(statusText('NOT_REQUIRED', 'screen')).toBe('Ready');
  });
});
