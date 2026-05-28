import { ipcMain } from 'electron';
import { recentScreenshots, todayScreenshotCount, captureOnce } from '../services/capture';
import { screenStatus } from '../services/permissions';

export function registerCaptureIpc(): void {
  ipcMain.handle('screenshots:recent', (_e, limit?: number) => recentScreenshots(limit ?? 8));
  ipcMain.handle('screenshots:countToday', () => todayScreenshotCount());
  ipcMain.handle('screenshots:captureOnce', () => captureOnce());
  ipcMain.handle('permissions:screenStatus', () => screenStatus());
}
