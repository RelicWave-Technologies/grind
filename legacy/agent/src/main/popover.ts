import { screen } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';
import { createOverlayWindow, keepOnTop, releaseOnTop, trayPopoverPoint } from './windows/overlay';

/**
 * Tray popover — anchored under the menu-bar icon. Floats like every other
 * overlay (above fullscreen apps, on every Space) so a tray click always
 * lands it on the screen the user is looking at, but it stays transient:
 * it dismisses on blur when the user clicks away.
 */

let win: BrowserWindow | null = null;

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = createOverlayWindow({ width: 300, height: 340, hash: 'popover', rank: 'ambient' });
  win.on('blur', () => hidePopover());
  win.on('closed', () => {
    win = null;
  });
  return win;
}

/** Toggle the popover anchored under the tray icon, on the tray's own display. */
export function togglePopover(trayBounds: Rectangle): void {
  const w = ensure();
  if (w.isVisible()) {
    w.hide();
    return;
  }
  const { workArea } = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const bounds = w.getBounds();
  const point = trayPopoverPoint(trayBounds, workArea, bounds);
  w.setPosition(point.x, point.y, false);
  // Focus first: this surface dismisses on blur, so it has to be key. The
  // keeper skips its re-show while a window is focused, so holding it does not
  // fight that.
  w.show();
  w.focus();
  keepOnTop(w);
}

export function hidePopover(): void {
  releaseOnTop(win);
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}
