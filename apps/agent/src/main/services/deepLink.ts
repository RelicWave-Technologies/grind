import path from 'node:path';
import { app } from 'electron';
import { completeLarkLogin, cancelLarkLogin } from './auth';
import { startHeartbeat } from './heartbeat';
import { broadcast } from '../broadcast';
import { CALLBACK_SCHEME } from '../env';
import { log } from '../logger';

/**
 * Custom-scheme handling for Lark login. The system browser, after the OAuth
 * round-trip, redirects to timo://auth?code=<one-time> (or ?status / ?error).
 * The OS hands us that URL via `open-url` (macOS) or argv on `second-instance`
 * (Windows/Linux). We redeem the code for a session; non-success outcomes are
 * pushed to the renderer so the login screen can explain them.
 */
const PROTOCOL = CALLBACK_SCHEME;

/** Register the callback scheme. In dev (electron-vite) we must pass the
 *  script path so the OS maps the scheme to this running instance. Returns the
 *  OS result — on Windows this is the ONLY thing that registers `timo://`
 *  (electron-builder's `protocols:` block writes nothing for NSIS), so a
 *  `false` here means the deep-link login can't complete. Worth logging. */
export function registerProtocol(): boolean {
  const scriptPath = process.argv[1];
  if (process.defaultApp && scriptPath) {
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
  // Only handle our own auth callback.
  if (parsed.protocol !== `${PROTOCOL}:` || parsed.host !== 'auth') return;

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
