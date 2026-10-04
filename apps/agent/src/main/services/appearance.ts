import { BrowserWindow, nativeTheme } from 'electron';
import { broadcast } from '../broadcast';
import { getPreferences, patchAppearance } from './preferences';
import type { Appearance } from '../../shared/appearance';

/** The main window's backing colour, painted before the page loads. */
const WINDOW_BACKGROUND = { light: '#F2F2F7', dark: '#15181C' } as const;

/**
 * Applies the app theme to everything the system draws for us (title bar,
 * native menus, `prefers-color-scheme` in every renderer) via
 * nativeTheme.themeSource, and repaints the main window's backing colour so a
 * dark window never flashes light. The pill's theme is applied by its own
 * renderer from the broadcast.
 */
export function applyAppearance(appearance: Appearance = getPreferences().appearance): void {
  nativeTheme.themeSource = appearance.app;
  const background = nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.isAlwaysOnTop()) win.setBackgroundColor(background);
  }
}

export function mainWindowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

export function setAppearance(patch: Partial<Appearance>): Appearance {
  const { appearance } = patchAppearance(patch);
  applyAppearance(appearance);
  broadcast('appearance:push', appearance);
  return appearance;
}

/** Follow the OS when the app theme is "system", so open windows repaint live. */
export function watchSystemAppearance(): void {
  nativeTheme.on('updated', () => {
    applyAppearance();
    broadcast('appearance:push', getPreferences().appearance);
  });
}
