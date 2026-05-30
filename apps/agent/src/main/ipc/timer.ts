import { ipcMain } from 'electron';
import { getTimerService } from '../services/timer';
import { broadcast } from '../broadcast';
import { api } from '../services/apiClient';
import { log } from '../logger';

export function registerTimerIpc(): void {
  ipcMain.handle(
    'timer:start',
    async (_e, args: { larkTaskGuid?: string | null }) => {
      const status = await getTimerService().start({ larkTaskGuid: args.larkTaskGuid ?? null });
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
      larkTaskGuid: e.larkTaskGuid ?? null,
      segments: e.segments.map((s) => ({ kind: s.kind, startedAt: s.startedAt, endedAt: s.endedAt })),
    }));
  });

  /**
   * Patch metadata on a tracked TimeEntry (Edit Time inline edit on green
   * rows). Only larkTaskGuid + notes. No approval needed — it's metadata.
   * Returns { ok, error?, entry? } so the renderer can show row error state.
   */
  ipcMain.handle(
    'timer:patchEntry',
    async (
      _e,
      args: { id: string; larkTaskGuid?: string | null; notes?: string | null },
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const body: Record<string, unknown> = {};
        if (args.larkTaskGuid !== undefined) body.larkTaskGuid = args.larkTaskGuid;
        if (args.notes !== undefined) body.notes = args.notes;
        await api(`/v1/time-entries/${args.id}`, { method: 'PATCH', body });
        return { ok: true };
      } catch (err) {
        const msg = String(err);
        log.warn('timer:patchEntry failed', { err: msg, id: args.id });
        if (msg.includes('403')) return { ok: false, error: 'forbidden' };
        if (msg.includes('404')) return { ok: false, error: 'not_found' };
        if (msg.includes('400')) return { ok: false, error: 'invalid' };
        return { ok: false, error: msg };
      }
    },
  );
}
