import { ipcMain, type BrowserWindow } from 'electron';
import { getTimerService } from '../services/timer';
import { log } from '../logger';

export function registerTimerIpc(win: BrowserWindow): void {
  ipcMain.handle('timer:start', async (_e, args: { projectId: string; taskId?: string | null }) => {
    const status = await getTimerService().start({ projectId: args.projectId, taskId: args.taskId ?? null });
    win.webContents.send('timer:status:push', status);
    return status;
  });

  ipcMain.handle('timer:stop', async () => {
    const status = await getTimerService().stop();
    win.webContents.send('timer:status:push', status);
    return status;
  });

  ipcMain.handle('timer:status', () => {
    return getTimerService().status();
  });

  ipcMain.handle('timer:today', () => {
    const entries = getTimerService().listToday(Date.now());
    return entries.map((e) => ({
      id: e.id,
      projectId: e.projectId,
      segments: e.segments.map((s) => ({ kind: s.kind, startedAt: s.startedAt, endedAt: s.endedAt })),
    }));
  });

  // Push a live status tick to the renderer every second while running, so the
  // UI elapsed time stays accurate without the renderer polling.
  setInterval(() => {
    try {
      const svc = getTimerService();
      if (svc.isRunning()) win.webContents.send('timer:status:push', svc.status());
    } catch (err) {
      log.warn('timer tick failed', { err: String(err) });
    }
  }, 1000);
}
