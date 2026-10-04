import { ipcMain } from 'electron';
import {
  recentScreenshots,
  captureOnce,
  fullScreenshot,
  thumbnailScreenshot,
  retryFailedUploads,
  screenshotUploadSummary,
} from '../services/capture';

export function registerCaptureIpc(): void {
  ipcMain.handle('screenshots:recent', (_e, limit?: number) => recentScreenshots(limit ?? 8));
  ipcMain.handle('screenshots:captureOnce', () => captureOnce());
  ipcMain.handle('screenshots:full', (_e, id: string) => fullScreenshot(id));
  ipcMain.handle('screenshots:thumbnail', (_e, id: string) => thumbnailScreenshot(id));
  ipcMain.handle('screenshots:uploadSummary', () => screenshotUploadSummary());
  ipcMain.handle('screenshots:retryFailedUploads', () => retryFailedUploads());
}
