import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import { ScreenshotStore } from './store';
import { captureNow, thumbDataUrl } from './capture';
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
      // Activity for the window this shot represents: from the previous (older)
      // shot up to this one (capped to 30 min), aligned to the shot's minute.
      const older = rows[i + 1];
      const to = r.capturedAt + 60_000;
      const from = older ? older.capturedAt + 60_000 : r.capturedAt - DEFAULT_WINDOW_MS;
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
