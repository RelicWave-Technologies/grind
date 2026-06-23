import { ipcMain } from 'electron';
import { checkForUpdates, getUpdateStatus, installUpdateNow } from '../services/updates';

export function registerUpdatesIpc(): void {
  ipcMain.handle('updates:status', () => getUpdateStatus());
  ipcMain.handle('updates:checkNow', () => checkForUpdates(true));
  ipcMain.handle('updates:installNow', () => installUpdateNow());
}
