import { describe, expect, it } from 'vitest';
import { trayMenuTitleForElapsed, trayTooltipForElapsed } from './trayPresentation';

describe('tray presentation', () => {
  it('keeps the stopped menu-bar item icon-sized', () => {
    expect(trayMenuTitleForElapsed()).toBe('');
    expect(trayMenuTitleForElapsed('')).toBe('');
    expect(trayTooltipForElapsed()).toBe('Timo');
  });

  it('shows the shortest running elapsed title while the tooltip keeps app identity', () => {
    expect(trayMenuTitleForElapsed('00:42')).toBe(' 00:42');
    expect(trayTooltipForElapsed('00:42')).toBe('Timo 00:42');
  });

  it('falls back to visible text if the tray icon cannot load', () => {
    expect(trayMenuTitleForElapsed('', { hasIcon: false })).toBe('Timo');
    expect(trayMenuTitleForElapsed('00:42', { hasIcon: false })).toBe('Timo 00:42');
  });
});
