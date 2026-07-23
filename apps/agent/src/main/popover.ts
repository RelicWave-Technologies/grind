import { screen } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';
import { assertOverlayFloat, createOverlayWindow, trayPopoverPoint } from './windows/overlay';

/**
 * Tray popover — anchored under the menu-bar icon. Floats like every other
 * overlay (above fullscreen apps, on every Space) so a tray click always
 * lands it on the screen the user is looking at, but it stays transient:
 * it dismisses on blur when the user clicks away.
 */

let win: BrowserWindow | null = null;

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = createOverlayWindow({ width: 300, height: 340, hash: 'popover' });
  win.on('blur', () => win?.hide());
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
  assertOverlayFloat(w); // re-assert on every show — macOS drops the flags
  w.show();
  w.focus();
}

export function hidePopover(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}
