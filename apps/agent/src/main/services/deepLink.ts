import path from 'node:path';
import { app } from 'electron';
import { completeLarkLogin, cancelLarkLogin } from './auth';
import { startHeartbeat } from './heartbeat';
import { broadcast } from '../broadcast';
import { log } from '../logger';

/**
 * grind:// custom-scheme handling for Lark login. The system browser, after the
 * OAuth round-trip, redirects to grind://auth?code=<one-time> (or ?status / ?error).
 * The OS hands us that URL via `open-url` (macOS) or argv on `second-instance`
 * (Windows/Linux). We redeem the code for a session; non-success outcomes are
 * pushed to the renderer so the login screen can explain them.
 */
const PROTOCOL = 'grind';

/** Register grind:// as our scheme. In dev (electron-vite) we must pass the
 *  script path so the OS maps the scheme to this running instance. */
export function registerProtocol(): void {
  const scriptPath = process.argv[1];
  if (process.defaultApp && scriptPath) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(scriptPath)]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

let ready = false;
let queued: string | null = null;

/** Pull a grind:// URL out of a process argv (Windows/Linux delivery). */
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
  // Only handle grind://auth?...
  if (parsed.protocol !== `${PROTOCOL}:` || parsed.host !== 'auth') return;

  const code = parsed.searchParams.get('code');
  const status = parsed.searchParams.get('status');
  const error = parsed.searchParams.get('error');

  try {
    if (code) {
      const ok = await completeLarkLogin(code);
      if (ok) {
        startHeartbeat();
        broadcast('auth:status:push', 'loggedIn');
      } else {
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
