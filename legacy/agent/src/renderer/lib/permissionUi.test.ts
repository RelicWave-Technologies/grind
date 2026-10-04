import { describe, it, expect } from 'vitest';
import { actionFor, isReady, statusText } from './permissionUi';

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

  it('still offers a restart where one genuinely applies', () => {
    // Screen Recording really does need a relaunch to take effect after a grant.
    expect(actionFor('NEEDS_RESTART', 'screen')).toBe('restart');
    expect(actionFor('FAILED', 'screen')).toBe('restart');
    expect(statusText('NEEDS_RESTART', 'accessibility')).toBe('Restart Timo to apply');
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
