import { ipcMain } from 'electron';
import {
  recentScreenshots,
  screenshotsInRange,
  fullScreenshot,
  thumbnailScreenshot,
  screenshotUploadSummary,
} from '../services/capture';

export function registerCaptureIpc(): void {
  ipcMain.handle('screenshots:recent', (_e, limit?: number) => recentScreenshots(limit ?? 8));
  ipcMain.handle('screenshots:range', (_e, fromMs: number, toMs: number) => screenshotsInRange(Number(fromMs), Number(toMs)));
  ipcMain.handle('screenshots:full', (_e, id: string) => fullScreenshot(id));
  ipcMain.handle('screenshots:thumbnail', (_e, id: string) => thumbnailScreenshot(id));
  ipcMain.handle('screenshots:uploadSummary', () => screenshotUploadSummary());
}
