import { BrowserWindow } from 'electron';

/**
 * Send an IPC message to every open renderer (main window, floating bar, popover).
 *
 * `skipIfHidden` leaves out one window while it is hidden — for high-frequency
 * pushes that a window catches up on when it is next shown.
 */
export function broadcast(
  channel: string,
  payload: unknown,
  opts: { skipIfHidden?: BrowserWindow | null } = {},
): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    if (w === opts.skipIfHidden && !w.isVisible()) continue;
    w.webContents.send(channel, payload);
  }
}
