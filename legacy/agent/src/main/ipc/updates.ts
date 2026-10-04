import { ipcMain } from 'electron';
import { checkForUpdates, checkForUpdatesQuietly, getUpdateStatus, installUpdateNow } from '../services/updates';

export function registerUpdatesIpc(): void {
  ipcMain.handle('updates:status', () => getUpdateStatus());
  ipcMain.handle('updates:checkNow', () => checkForUpdates(true));
  ipcMain.handle('updates:checkQuietly', () => checkForUpdatesQuietly('settings-open'));
  ipcMain.handle('updates:installNow', () => installUpdateNow());
}
