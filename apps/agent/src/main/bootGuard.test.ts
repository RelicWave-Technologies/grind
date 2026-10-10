import { describe, expect, it, vi } from 'vitest';
import { guardBootStep, uiBootOutcome } from './bootGuard';

describe('guardBootStep', () => {
  it('returns what the step returns', () => {
    const logger = { error: vi.fn() };
    expect(guardBootStep(logger, 'tray', () => 'tray')).toBe('tray');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a throwing step and carries on', () => {
    // A legacy login-item cleanup that threw here used to abort the whole boot
    // before the tray or window existed.
    const logger = { error: vi.fn() };
    const result = guardBootStep(logger, 'launch at login reconcile', () => {
      throw new Error('registry access denied');
    });
    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'boot: launch at login reconcile failed',
      expect.objectContaining({ err: 'Error: registry access denied' }),
    );
  });
});

describe('uiBootOutcome', () => {
  it('carries on with either the tray or the window', () => {
    expect(uiBootOutcome({ hasTray: true, hasWindow: true })).toBe('ready');
    expect(uiBootOutcome({ hasTray: true, hasWindow: false })).toBe('ready');
    expect(uiBootOutcome({ hasTray: false, hasWindow: true })).toBe('ready');
  });

  it('exits when nothing can be reached, so the single-instance lock is released', () => {
    expect(uiBootOutcome({ hasTray: false, hasWindow: false })).toBe('exit');
  });
});
