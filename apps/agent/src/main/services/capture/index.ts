import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import { ScreenshotStore } from './store';
import { captureNow, thumbDataUrl, fullDataUrl } from './capture';
import { nextDelayMs } from './scheduler';
import { getTimerService } from '../timer';
import { getActivityStore } from '../activity';
import { activityPercent } from '../activity/percent';
import { SCREENSHOT_INTERVAL_SEC } from '../../env';
import { type CaptureHealth } from '../permissions';
import { log } from '../../logger';

let store: ScreenshotStore | null = null;
let timer: NodeJS.Timeout | null = null;
let lastHealth: CaptureHealth = 'unknown';

/**
 * Compute the `[from, to)` epoch window to aggregate activity for a
 * single screenshot's per-shot bars.
 *
 * Two regimes:
 *  - **slow cadence** (3-hour production default): partition the timeline
 *    so each minute's sample is credited to exactly ONE shot, by starting
 *    the window 60s past the previous shot's capture time. This is what
 *    the original code did.
 *  - **fast cadence** (15s for testing / dogfood): adjacent shots share
 *    a minute. The partition logic would push the lower bound *past* the
 *    only sample that could land in the window, leaving every bar at zero
 *    except for the lucky shot that crossed a minute boundary. Clamp the
 *    lower bound to `capturedAt - 60s` so the past minute is always
 *    included. Several adjacent shots will then share the same bar (the
 *    minute's totals) — that's the right answer: the user really did do
 *    one minute of work, the camera just fired 4 times in it.
 *
 *  Exported so unit tests can lock the regression in: a 15s gap MUST
 *  yield a non-future-only window.
 */
export function activityWindowForShot(args: {
  capturedAt: number;
  olderCapturedAt?: number;
  defaultWindowMs: number;
}): { from: number; to: number } {
  const to = args.capturedAt + 60_000;
  const partitionFrom =
    args.olderCapturedAt != null
      ? args.olderCapturedAt + 60_000
      : args.capturedAt - args.defaultWindowMs;
  const from = Math.min(partitionFrom, args.capturedAt - 60_000);
  return { from, to };
}

/** Health of the most recent capture attempt (for surfacing revocation/restart). */
export function getScreenHealth(): CaptureHealth {
  return lastHealth;
}

function getStore(): ScreenshotStore {
  if (store) return store;
  const db = new Database(path.join(app.getPath('userData'), 'agent.db'));
  store = new ScreenshotStore(db);
  return store;
}

function schedule() {
  const delay = nextDelayMs(SCREENSHOT_INTERVAL_SEC * 1000);
  timer = setTimeout(() => void tick(), delay);
  log.info('next screenshot scheduled', { inMs: delay });
}

async function tick() {
  try {
    const status = getTimerService().status();
    // Only capture while actively tracking (running and not paused).
    if (status.state === 'RUNNING' && !status.paused) {
      const { rows, health } = await captureNow(status.entryId);
      lastHealth = health;
      for (const r of rows) getStore().insert(r);
    }
  } catch (err) {
    log.warn('screenshot tick failed', { err: String(err) });
  } finally {
    schedule();
  }
}

/** Start the jittered capture loop. */
export function startCaptureLoop(): void {
  if (timer) return;
  getStore();
  schedule();
}

export async function recentScreenshots(limit: number): Promise<
  { id: string; capturedAt: number; thumb: string | null; uploadState: string; keyboardPct: number; mousePct: number }[]
> {
  const rows = getStore().recent(limit); // newest-first
  const activity = getActivityStore();
  const DEFAULT_WINDOW_MS = 30 * 60_000;
  return Promise.all(
    rows.map(async (r, i) => {
      const older = rows[i + 1];
      const { from, to } = activityWindowForShot({
        capturedAt: r.capturedAt,
        olderCapturedAt: older?.capturedAt,
        defaultWindowMs: DEFAULT_WINDOW_MS,
      });
      let keyboardPct = 0;
      let mousePct = 0;
      try {
        const agg = activity.aggregate(from, to);
        ({ keyboard: keyboardPct, mouse: mousePct } = activityPercent(agg));
      } catch {
        /* activity store may be empty/unavailable */
      }
      return {
        id: r.id,
        capturedAt: r.capturedAt,
        uploadState: r.uploadState,
        thumb: await thumbDataUrl(r.filePath),
        keyboardPct,
        mousePct,
      };
    }),
  );
}

/** Full-resolution data URL for one screenshot (in-app lightbox). */
export async function fullScreenshot(id: string): Promise<string | null> {
  const row = getStore().find(id);
  if (!row) return null;
  return fullDataUrl(row.filePath);
}

export function todayScreenshotCount(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return getStore().countSince(d.getTime());
}

/** Capture immediately (manual "Take one now"). Forces the desktopCapturer
 *  call so macOS registers the app in Screen Recording even on first use. */
export async function captureOnce(): Promise<number> {
  const status = getTimerService().status();
  const { rows, health } = await captureNow(status.state === 'RUNNING' ? status.entryId : null, { force: true });
  lastHealth = health;
  for (const r of rows) getStore().insert(r);
  return rows.length;
}
