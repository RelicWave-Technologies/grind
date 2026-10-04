import { BrowserWindow } from 'electron';

/** Send an IPC message to every open renderer (main window, floating bar, popover). */
export function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
