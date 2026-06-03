import { isMeetingApp, MeetingTracker } from './detect';
import { getTimerService } from '../timer';
import { recordActiveWindow } from '../activity';
import { log } from '../../logger';

// get-windows is an OPTIONAL native dep (macOS/Win). We import it dynamically so
// a missing/unbuildable install (e.g. Linux CI) never breaks the app or types.
// `title` + `url` (Chrome/Safari only) are also exposed by get-windows; we read
// them best-effort for the M14 active-window tracker. The backend is the
// privacy gate — it scrubs disallowed fields per the workspace policy.
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
let tracker: MeetingTracker | null = null;
let interval: NodeJS.Timeout | null = null;
let inMeeting = false;

const POLL_MS = 10_000;

async function loadModule(): Promise<GetWindows | null> {
  if (modLoaded) return mod;
  modLoaded = true;
  try {
    mod = (await import('get-windows')) as unknown as GetWindows;
  } catch (err) {
    log.warn('get-windows unavailable — meeting detection disabled', { err: String(err) });
    mod = null;
  }
  return mod;
}

async function tick(): Promise<void> {
  try {
    const gw = await loadModule();
    if (!gw) return;
    // Only relevant while actively tracking.
    const status = getTimerService().status();
    if (status.state !== 'RUNNING' || status.paused) return;

    const win = await gw.activeWindow();
    // Feed the M14 active-window tracker — best-effort, the activity flush
    // resolves the dominant app for the bucket and the server scrubs
    // disallowed fields per the workspace policy.
    recordActiveWindow({
      ts: Date.now(),
      app: win?.owner?.name ?? null,
      appBundle: win?.owner?.bundleId ?? null,
      title: win?.title ?? null,
      url: win?.url ?? null,
    });
    const meetingNow = isMeetingApp(win?.owner?.name, win?.owner?.bundleId);
    const { inMeeting: now, changed } = tracker!.update(meetingNow);
    inMeeting = now;
    if (changed) {
      log.info('meeting state changed', { inMeeting: now });
      if (now) await getTimerService().beginMeeting(Date.now());
      else await getTimerService().endMeeting(Date.now());
    }
  } catch (err) {
    log.warn('meeting tick failed', { err: String(err) });
  }
}

export function startMeetingDetection(): void {
  if (interval) return;
  tracker = new MeetingTracker(3);
  interval = setInterval(() => void tick(), POLL_MS);
}

/** True while the user is detected to be in a meeting (protects against idle). */
export function isInMeeting(): boolean {
  return inMeeting;
}
