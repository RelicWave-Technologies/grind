import { ipcMain } from 'electron';
import { logout, isLoggedIn, startLarkLogin, ensureSession } from '../services/auth';
import { onAuthChange, notifyAuth, api } from '../services/apiClient';
import { stopHeartbeat } from '../services/heartbeat';
import { networkFetch } from '../services/network';
import { activateSignedInSession } from '../services/signIn';
import { broadcast } from '../broadcast';
import { log } from '../logger';
import { bindTimerToStoredSession, drainTimerSyncNow, getTimerService } from '../services/timer';
import { resumeUploads, stopUploads } from '../services/capture/uploader';

/** What the Sign out button gets back. A refusal leaves the timer untouched. */
type LogoutResult = { ok: true } | { ok: false; reason: 'time_waiting_to_sync' };

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

/**
 * Sign out without ever stranding tracked time.
 *
 * The old order stopped the timer first and only then asked whether everything
 * had synced — so on a bad network the user was left with a stopped timer, a
 * rejected sign-out, and no message (the error never reached the screen).
 *
 * Now the sync question is asked FIRST, while the timer is still running: if
 * the backlog (the running entry's latest checkpoint included) cannot reach the
 * server right now, nothing is touched and the caller is told why. Only once
 * that passes is the timer stopped. If the final close then fails to upload,
 * sign-out still completes: the row is durable and bound to this account, and
 * uploads the next time this person signs in. Stopping and then refusing is the
 * one outcome this never produces.
 */
async function signOutSafely(): Promise<LogoutResult> {
  const timer = getTimerService();
  await drainTimerSyncNow('manual').catch((err) => {
    log.warn('sign-out pre-check drain failed', { err: String(err) });
  });
  if (timer.hasUnsynced()) {
    log.warn('sign-out refused: tracked time still waiting to sync', { backlog: timer.syncBacklog() });
    return { ok: false, reason: 'time_waiting_to_sync' };
  }

  if (timer.isRunning()) {
    await timer.stop();
    await drainTimerSyncNow('manual').catch((err) => {
      log.warn('sign-out final drain failed', { err: String(err) });
    });
    if (timer.hasUnsynced()) {
      log.warn('signing out with the final stop still queued; it uploads at the next sign-in', {
        backlog: timer.syncBacklog(),
      });
    }
  }

  // A screenshot pass still running would send its next request with whatever
  // session is current. Stop it and wait for it before the tokens change; the
  // interrupted shot stays queued for this account's next sign-in.
  await stopUploads();
  try {
    stopHeartbeat();
    await logout();
    // Tokens are gone, so this binds no owner.
    await bindTimerToStoredSession(false);
  } finally {
    // Passes no-op without an owner; the next sign-in's uploads start normally.
    resumeUploads();
  }
  notifyAuth('loggedOut', { reason: 'manual' });
  return { ok: true };
}

let logoutInFlight: Promise<LogoutResult> | null = null;

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

  ipcMain.handle('auth:logout', (): Promise<LogoutResult> => {
    // A double click must not run two sign-outs against one timer.
    logoutInFlight ??= signOutSafely().finally(() => {
      logoutInFlight = null;
    });
    return logoutInFlight;
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
