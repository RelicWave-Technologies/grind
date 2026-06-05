import type { BrowserWindow } from 'electron';
import {
  createOverlayWindow,
  assertOverlayFloat,
  activeWorkArea,
  centerUpperThird,
} from './windows/overlay';

/**
 * "Still working?" idle prompt (M3). Appears centered on the display the user
 * is currently on, floating above any fullscreen app, on every Space.
 */

const SIZE = { width: 340, height: 280 };
let win: BrowserWindow | null = null;

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = createOverlayWindow({ ...SIZE, hash: 'idle' });
  win.on('closed', () => {
    win = null;
  });
  assertOverlayFloat(win);
  return win;
}

export function showIdlePrompt(): void {
  const w = ensure();
  const p = centerUpperThird(activeWorkArea(), SIZE);
  w.setPosition(p.x, p.y, false);
  assertOverlayFloat(w); // re-assert: float flags drop after sleep/Space switch
  w.show();
  w.focus();
}

export function hideIdlePrompt(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}
