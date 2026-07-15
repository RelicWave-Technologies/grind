import path from 'node:path';
import { app } from 'electron';
import { completeLarkLogin, cancelLarkLogin } from './auth';
import { startHeartbeat } from './heartbeat';
import { broadcast } from '../broadcast';
import { CALLBACK_SCHEME } from '../env';
import { log } from '../logger';
import { refreshAgentConfig } from './agentConfig';
import { bindTimerToStoredSession, drainTimerSyncNow, refreshTodayLedger } from './timer';

/**
 * Custom-scheme handling for Lark login. The system browser, after the OAuth
 * round-trip, redirects to timo://auth?code=<one-time> (or ?status / ?error).
 * The OS hands us that URL via `open-url` (macOS) or argv on `second-instance`
 * (Windows/Linux). We redeem the code for a session; non-success outcomes are
 * pushed to the renderer so the login screen can explain them.
 */
const PROTOCOL = CALLBACK_SCHEME;
let larkConnectionHandler: ((outcome: 'connected' | 'cancelled' | 'failed') => void) | null = null;

/** Main window ownership stays in index.ts; this service only delivers the verified outcome. */
export function setLarkConnectionHandler(handler: (outcome: 'connected' | 'cancelled' | 'failed') => void): void {
  larkConnectionHandler = handler;
}

/** Register the callback scheme. Windows development needs the entry path so
 *  a second launch can boot this app instead of bare Electron. macOS ignores
 *  path/args and relies on the scheme baked into the development bundle by
 *  prepare-dev-electron.mjs. */
export function registerProtocol(): boolean {
  const scriptPath = process.argv[1];
  if (process.defaultApp && process.platform === 'win32' && scriptPath) {
    return app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(scriptPath)]);
  }
  return app.setAsDefaultProtocolClient(PROTOCOL);
}

let ready = false;
let queued: string | null = null;

/** Pull our callback URL out of a process argv (Windows/Linux delivery). */
export function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((a) => a.startsWith(`${PROTOCOL}://`)) ?? null;
}

/** Mark the app ready and flush any deep-link that arrived during startup. */
export function flushQueuedDeepLink(): void {
  ready = true;
  if (queued) {
    const url = queued;
    queued = null;
    void handleDeepLink(url);
  }
}

export async function handleDeepLink(url: string): Promise<void> {
  if (!ready) {
    queued = url; // arrived before the app finished booting — replay on ready
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    log.warn('deep link: unparseable url');
    return;
  }
  if (parsed.protocol !== `${PROTOCOL}:`) return;
  if (parsed.host === 'lark') {
    const status = parsed.searchParams.get('status');
    const outcome = status === 'connected' || status === 'cancelled' || status === 'failed' ? status : 'failed';
    log.info('deep link: lark connection callback received', { outcome });
    larkConnectionHandler?.(outcome);
    broadcast('lark:connection:push', { outcome });
    return;
  }
  // Main sign-in callback.
  if (parsed.host !== 'auth') return;

  const code = parsed.searchParams.get('code');
  const status = parsed.searchParams.get('status');
  const error = parsed.searchParams.get('error');
  log.info('deep link: auth callback received', {
    hasCode: Boolean(code),
    status: status ?? null,
    hasError: Boolean(error),
  });

  try {
    if (code) {
      const ok = await completeLarkLogin(code);
      if (ok) {
        await bindTimerToStoredSession(false);
        await drainTimerSyncNow('auth');
        await refreshAgentConfig();
        void refreshTodayLedger('auth');
        startHeartbeat();
        broadcast('auth:status:push', 'loggedIn');
      } else {
        log.warn('deep link: login code was not exchanged');
        broadcast('auth:lark:push', { kind: 'error', reason: 'auth_failed' });
      }
    } else if (status === 'pending') {
      cancelLarkLogin();
      broadcast('auth:lark:push', { kind: 'pending' });
    } else if (error) {
      cancelLarkLogin();
      broadcast('auth:lark:push', { kind: 'error', reason: error });
    }
  } catch (err) {
    cancelLarkLogin();
    log.warn('deep link: login exchange failed', { err: String(err) });
    broadcast('auth:lark:push', { kind: 'error', reason: 'auth_failed' });
  }
}
