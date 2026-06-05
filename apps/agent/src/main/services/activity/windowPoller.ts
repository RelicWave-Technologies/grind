import { getTimerService } from '../timer';
import { recordActiveWindow } from './index';
import { log } from '../../logger';

/**
 * Polls the foreground window (~10s) and feeds the active-window tracker for
 * the M14 app/site usage panel. Policy-gated server-side — titles/URLs are
 * scrubbed on ingestion unless the workspace allows them.
 *
 * (This used to also drive automatic meeting detection, which was removed:
 * browser-tab call detection needed Screen Recording + a scriptable browser
 * and was unreliable. Meeting time is now logged via the manual-time approval
 * flow instead.)
 *
 * get-windows is an OPTIONAL native dep imported dynamically, so a missing /
 * unbuildable install (e.g. Linux CI) never breaks the app.
 */
type ActiveWindow =
  | {
      owner?: { name?: string; bundleId?: string };
      title?: string;
      url?: string;
    }
  | undefined;
type GetWindows = { activeWindow: () => Promise<ActiveWindow> };

let mod: GetWindows | null = null;
let modLoaded = false;
let interval: NodeJS.Timeout | null = null;

const POLL_MS = 10_000;

async function loadModule(): Promise<GetWindows | null> {
  if (modLoaded) return mod;
  modLoaded = true;
  try {
    mod = (await import('get-windows')) as unknown as GetWindows;
  } catch (err) {
    log.warn('get-windows unavailable — app/site capture disabled', { err: String(err) });
    mod = null;
  }
  return mod;
}

async function tick(): Promise<void> {
  try {
    const gw = await loadModule();
    if (!gw) return;
    // Only capture while actively tracking.
    const status = getTimerService().status();
    if (status.state !== 'RUNNING' || status.paused) return;

    const win = await gw.activeWindow();
    recordActiveWindow({
      ts: Date.now(),
      app: win?.owner?.name ?? null,
      appBundle: win?.owner?.bundleId ?? null,
      title: win?.title ?? null,
      url: win?.url ?? null,
    });
  } catch (err) {
    log.warn('active-window tick failed', { err: String(err) });
  }
}

export function startActiveWindowPolling(): void {
  if (interval) return;
  interval = setInterval(() => void tick(), POLL_MS);
}

export function stopActiveWindowPolling(): void {
  if (interval) clearInterval(interval);
  interval = null;
}
