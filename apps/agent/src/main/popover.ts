import { screen } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';
import { createOverlayWindow } from './windows/overlay';

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
  const pw = w.getBounds().width;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - pw / 2);
  x = Math.max(workArea.x + 6, Math.min(x, workArea.x + workArea.width - pw - 6));
  const y = Math.round(trayBounds.y + trayBounds.height + 6);
  w.setPosition(x, y, false);
  w.show();
  w.focus();
}

export function hidePopover(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}
