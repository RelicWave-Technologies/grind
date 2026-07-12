import { ipcMain } from 'electron';
import { getTimerService } from '../services/timer';
import { sendHeartbeatNow } from '../services/heartbeat';
import { broadcast } from '../broadcast';
import { clearPendingTrackingCommand, resumeTracking, startTracking } from '../services/trackingCommands';

export function registerTimerIpc(): void {
  ipcMain.handle(
    'timer:start',
    async (_e, args: { larkTaskGuid?: string | null }) => {
      return startTracking(args.larkTaskGuid ?? null);
    },
  );

  ipcMain.handle('timer:stop', async () => {
    clearPendingTrackingCommand();
    const status = await getTimerService().stop();
    broadcast('timer:status:push', status);
    sendHeartbeatNow();
    return status;
  });

  ipcMain.handle('timer:resume', async () => {
    return resumeTracking();
  });

  ipcMain.handle('timer:status', () => getTimerService().status());
  ipcMain.handle('timer:recoveryNotice', () => getTimerService().recoveryNotice());
  ipcMain.handle('timer:dismissRecoveryNotice', () => {
    getTimerService().dismissRecoveryNotice();
    return { ok: true };
  });

  ipcMain.handle('timer:today', () => {
    const entries = getTimerService().listToday(Date.now());
    return entries.map((e) => ({
      id: e.id,
      larkTaskGuid: e.larkTaskGuid ?? null,
      segments: e.segments.map((s) => ({ kind: s.kind, startedAt: s.startedAt, endedAt: s.endedAt })),
    }));
  });
}
