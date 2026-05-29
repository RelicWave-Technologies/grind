import { isMeetingApp, MeetingTracker } from './detect';
import { getTimerService } from '../timer';
import { log } from '../../logger';

// get-windows is an OPTIONAL native dep (macOS/Win). We import it dynamically so
// a missing/unbuildable install (e.g. Linux CI) never breaks the app or types.
type ActiveWindow = { owner?: { name?: string; bundleId?: string } } | undefined;
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
