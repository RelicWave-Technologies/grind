import { ipcMain } from 'electron';
import { logout, isLoggedIn, startLarkLogin, ensureSession } from '../services/auth';
import { onAuthChange, notifyAuth, api } from '../services/apiClient';
import { stopHeartbeat } from '../services/heartbeat';
import { networkFetch } from '../services/network';
import { activateSignedInSession } from '../services/signIn';
import { broadcast } from '../broadcast';
import { log } from '../logger';
import { bindTimerToStoredSession, drainTimerSyncNow, getTimerService } from '../services/timer';

/** Fetch a remote image and return it as a `data:` URL (renderer CSP allows
 *  data: but not remote img). Returns null on any failure or oversized image. */
async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await networkFetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 1_000_000) return null;
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export function registerAuthIpc(): void {
  // Start the Lark login flow: opens the system browser. The custom deep-link
  // (handled in services/deepLink) completes it and broadcasts the outcome.
  ipcMain.handle('auth:loginWithLark', async () => {
    if (await ensureSession()) {
      await activateSignedInSession('stored_session');
      return { ok: true };
    }
    await startLarkLogin();
    return { ok: true };
  });

  ipcMain.handle('auth:logout', async () => {
    const timer = getTimerService();
    await timer.stop();
    await drainTimerSyncNow('manual');
    if (timer.hasUnsynced()) {
      throw new Error('time_waiting_to_sync');
    }
    stopHeartbeat();
    await logout();
    await bindTimerToStoredSession(false);
    notifyAuth('loggedOut', { reason: 'manual' });
    return { ok: true };
  });

  ipcMain.handle('auth:status', async () => {
    return (await isLoggedIn()) ? 'loggedIn' : 'loggedOut';
  });

  // The signed-in user's display identity (name + Lark avatar) for the sidebar.
  // Returns null when logged out or on any error — the UI falls back to initials.
  // The avatar is inlined as a data URL because the renderer CSP is
  // `img-src 'self' data:` (no remote images); fetching it here (main process,
  // no CSP) sidesteps that and works for any avatar host.
  ipcMain.handle('auth:me', async (): Promise<{ name: string; avatarUrl: string | null } | null> => {
    try {
      const { user } = await api<{ user: { name: string; avatarUrl: string | null } }>('/v1/auth/me');
      let avatarUrl = user.avatarUrl ?? null;
      if (avatarUrl && /^https?:\/\//i.test(avatarUrl)) {
        avatarUrl = (await fetchImageAsDataUrl(avatarUrl)) ?? null;
      }
      return { name: user.name, avatarUrl };
    } catch {
      return null;
    }
  });

  onAuthChange((status, info) => {
    log.info('auth status change pushed', { status, reason: info.reason ?? null });
    broadcast('auth:status:push', status);
    if (status === 'loggedOut') stopHeartbeat();
  });
}
