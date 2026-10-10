import { ipcMain } from 'electron';
import { getPreferences } from '../services/preferences';
import { getTimerService } from '../services/timer';
import { serverAlignedNow } from '../services/serverClock';
import { pauseTracking, resumeTracking, startTracking, stopTracking } from '../services/trackingCommands';

export function registerTimerIpc(): void {
  ipcMain.handle(
    'timer:start',
    async (_e, args: { larkTaskGuid?: string | null }) => {
      return startTracking(args.larkTaskGuid ?? null);
    },
  );

  ipcMain.handle('timer:stop', () => stopTracking());

  ipcMain.handle('timer:pause', () => pauseTracking());

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
    // The timer's own frame: the device clock can sit on the other side of
    // midnight from the entries it is filtering.
    const entries = getTimerService().listToday(serverAlignedNow());
    return entries.map((e) => ({
      id: e.id,
      source: e.source,
      larkTaskGuid: e.larkTaskGuid ?? null,
      segments: e.segments.map((s) => ({ kind: s.kind, startedAt: s.startedAt, endedAt: s.endedAt })),
    }));
  });
}
