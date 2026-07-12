import { ipcMain } from 'electron';
import { getAwayInfo, hideAwayPrompt, type AwayInfo } from '../awayPrompt';
import { startTracking } from '../services/trackingCommands';

/**
 * IPC for the "welcome back — resume?" toast. `resume` starts a fresh entry on
 * the same task the user was tracking when the machine went away (the away gap
 * itself is never billed — the old entry was already closed at the away
 * boundary), so this is a clean restart, not a resume of a paused entry.
 */
export function registerAwayIpc(): void {
  ipcMain.handle('away:get', (): AwayInfo | null => getAwayInfo());

  ipcMain.handle('away:resume', async () => {
    const info = getAwayInfo();
    const result = await startTracking(info?.larkTaskGuid ?? null);
    hideAwayPrompt();
    return result;
  });

  ipcMain.handle('away:dismiss', () => {
    hideAwayPrompt();
    return { ok: true as const };
  });
}
