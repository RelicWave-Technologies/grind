import { ipcMain } from 'electron';
import { getPreferences } from '../services/preferences';
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

  ipcMain.handle('timer:pause', async () => {
    clearPendingTrackingCommand();
    const status = await getTimerService().pause();
    broadcast('timer:status:push', status);
    sendHeartbeatNow();
    return status;
  });

  ipcMain.handle('timer:resume', async () => {
    return resumeTracking();
  });

  ipcMain.handle('timer:status', () => getTimerService().status());
  // The task the user last tracked. Boot always closes the open entry, so the
  // timer status can't carry this across a restart — the renderer needs it to
  // pre-select the work they were actually on instead of the first task in the
  // list.
  ipcMain.handle('timer:lastTaskGuid', (): string | null => getPreferences().lastLarkTaskGuid);
  ipcMain.handle('timer:recoveryNotice', () => getTimerService().recoveryNotice());
  ipcMain.handle('timer:dismissRecoveryNotice', () => {
    getTimerService().dismissRecoveryNotice();
    return { ok: true };
  });

  ipcMain.handle('timer:today', () => {
    const entries = getTimerService().listToday(Date.now());
    return entries.map((e) => ({
      id: e.id,
      source: e.source,
      larkTaskGuid: e.larkTaskGuid ?? null,
      segments: e.segments.map((s) => ({ kind: s.kind, startedAt: s.startedAt, endedAt: s.endedAt })),
    }));
  });
}
