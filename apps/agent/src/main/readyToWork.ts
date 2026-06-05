import type { BrowserWindow } from 'electron';
import {
  createOverlayWindow,
  assertOverlayFloat,
  activeWorkArea,
  topRight,
} from './windows/overlay';

/**
 * "Ready to work?" toast (M12/2) — a small notification that appears at the
 * top-right of the display the user is currently on when their shift window
 * opens. Floats above fullscreen apps, on every Space.
 *
 * Lifecycle is owned by ShiftMonitor; this module creates + positions it.
 */

const SIZE = { width: 320, height: 168 };
let win: BrowserWindow | null = null;

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = createOverlayWindow({ ...SIZE, hash: 'ready-to-work' });
  assertOverlayFloat(win);
  // If the user closes via window controls (rare; chrome is hidden), treat
  // as a "Not yet" — the renderer's onbeforeunload should beat us to it.
  win.on('closed', () => {
    win = null;
  });
  return win;
}

export function showReadyToWork(): void {
  const w = ensure();
  const p = topRight(activeWorkArea(), SIZE);
  w.setPosition(p.x, p.y, false);
  assertOverlayFloat(w); // re-assert: float flags drop after sleep/Space switch
  // A notification, not a modal — don't steal focus.
  w.showInactive();
}

export function hideReadyToWork(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

export function isReadyToWorkVisible(): boolean {
  return !!(win && !win.isDestroyed() && win.isVisible());
}
