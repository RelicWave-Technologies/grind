import { screen } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';
import { createOverlayWindow, trayPopoverPoint } from './windows/overlay';

/**
 * Tray popover — anchored under the menu-bar icon. Closes on blur. Unlike the
 * other overlays it is deliberately NOT forced to all-Spaces / over-fullscreen:
 * it belongs to the tray, which lives on the menu-bar display, and should
 * dismiss when the user clicks away.
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
  w.show();
  w.focus();
}

export function hidePopover(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}
