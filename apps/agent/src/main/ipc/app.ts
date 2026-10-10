import { app, ipcMain, shell } from 'electron';
import { getDashboardUrl, refreshAgentConfig } from '../services/agentConfig';
import { log } from '../logger';
import { isSafeExternalUrl } from '../externalUrl';

/**
 * App-level shell actions. `app:openDashboard` opens the web dashboard in the
 * user's default browser. The URL comes from the server config (DASHBOARD_URL),
 * cached by agentConfig — if it hasn't been fetched yet we fetch once on demand
 * so the button works even right after launch. Only an https URL (or local
 * http in development) is ever opened — see externalUrl.
 */
export function registerAppIpc(): void {
  ipcMain.handle('app:openDashboard', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      let url = getDashboardUrl();
      if (!url) {
        await refreshAgentConfig();
        url = getDashboardUrl();
      }
      if (!url) return { ok: false, error: 'no_dashboard_url' };
      if (!isSafeExternalUrl(url, { allowLocalHttp: !app.isPackaged })) {
        log.warn('app:openDashboard refused an unsafe dashboard URL', { scheme: url.split(':')[0]?.slice(0, 32) ?? null });
        return { ok: false, error: 'unsafe_dashboard_url' };
      }
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      log.warn('app:openDashboard failed', { err: String(err) });
      return { ok: false, error: String(err) };
    }
  });
}
