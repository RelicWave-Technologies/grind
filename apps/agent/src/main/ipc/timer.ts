import { ipcMain } from 'electron';
import { getTimerService } from '../services/timer';
import { broadcast } from '../broadcast';

export function registerTimerIpc(): void {
  ipcMain.handle(
    'timer:start',
    async (_e, args: { projectId?: string | null; taskId?: string | null; larkTaskGuid?: string | null }) => {
      const status = await getTimerService().start({
        projectId: args.projectId ?? null,
        taskId: args.taskId ?? null,
        larkTaskGuid: args.larkTaskGuid ?? null,
      });
      broadcast('timer:status:push', status);
      return status;
    },
  );

  ipcMain.handle('timer:stop', async () => {
    const status = await getTimerService().stop();
    broadcast('timer:status:push', status);
    return status;
  });

  ipcMain.handle('timer:status', () => getTimerService().status());

  ipcMain.handle('timer:today', () => {
    const entries = getTimerService().listToday(Date.now());
    return entries.map((e) => ({
      id: e.id,
      projectId: e.projectId,
      larkTaskGuid: e.larkTaskGuid ?? null,
      segments: e.segments.map((s) => ({ kind: s.kind, startedAt: s.startedAt, endedAt: s.endedAt })),
    }));
  });
}
