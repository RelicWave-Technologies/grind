import { ipcMain } from 'electron';
import { screenshotsInRange, fullScreenshot, thumbnailScreenshot } from '../services/capture';

export function registerCaptureIpc(): void {
  ipcMain.handle('screenshots:range', (_e, fromMs: number, toMs: number) => screenshotsInRange(Number(fromMs), Number(toMs)));
  ipcMain.handle('screenshots:full', (_e, id: string) => fullScreenshot(id));
  ipcMain.handle('screenshots:thumbnail', (_e, id: string) => thumbnailScreenshot(id));
}
