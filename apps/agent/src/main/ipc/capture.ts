import { ipcMain } from 'electron';
import {
  recentScreenshots,
  todayScreenshotCount,
  captureOnce,
  getScreenHealth,
  fullScreenshot,
  thumbnailScreenshot,
  retryFailedUploads,
  screenshotUploadSummary,
} from '../services/capture';
import { screenStatus, screenUiState } from '../services/permissions';

export function registerCaptureIpc(): void {
  ipcMain.handle('screenshots:recent', (_e, limit?: number) => recentScreenshots(limit ?? 8));
  ipcMain.handle('screenshots:countToday', () => todayScreenshotCount());
  ipcMain.handle('screenshots:captureOnce', () => captureOnce());
  ipcMain.handle('screenshots:full', (_e, id: string) => fullScreenshot(id));
  ipcMain.handle('screenshots:thumbnail', (_e, id: string) => thumbnailScreenshot(id));
  ipcMain.handle('screenshots:uploadSummary', () => screenshotUploadSummary());
  ipcMain.handle('screenshots:retryFailedUploads', () => retryFailedUploads());

  // Combined permission view: raw status + last capture health + the derived
  // UI state (ok | needs-grant | needs-settings | needs-restart).
  ipcMain.handle('permissions:screen', () => {
    const status = screenStatus();
    const health = getScreenHealth();
    return { status, health, state: screenUiState(status, health) };
  });
}
