import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ScreenshotStore, type ScreenshotUploadSummary } from './store';
import { captureNow, thumbDataUrl, fullDataUrl } from './capture';
import { nextDelayMs } from './scheduler';
import { planScreenshotRetention } from './retention';
import { startUploader, drainUploads, uploadScreenshotsNow } from './uploader';
import { getTimerService } from '../timer';
import { getWorkspaceTimeContext } from '../workspaceTime';
import { getActivityStore } from '../activity';
import { activityPercent } from '../activity/percent';
import { SCREENSHOT_RETENTION_DAYS } from '../../env';
import { getScreenshotIntervalSec } from '../agentConfig';
import { type CaptureHealth } from '../permissions';
import { log } from '../../logger';

let store: ScreenshotStore | null = null;
let timer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let lastHealth: CaptureHealth = 'unknown';
const healthListeners = new Set<(health: CaptureHealth) => void>();

/**
 * Compute the `[from, to)` epoch window to aggregate activity for a
 * single screenshot's per-shot bars.
 *
 * Two regimes:
 *  - **normal cadence** (1-3 minutes): partition the timeline so each
 *    minute's sample is credited to exactly ONE shot, by starting the window
 *    60s past the previous shot's capture time.
 *  - **sub-minute dev/test cadence**: adjacent shots share a minute. The
 *    partition logic would push the lower bound *past* the only sample that
 *    could land in the window, leaving every bar at zero except for the lucky
 *    shot that crossed a minute boundary. Clamp the lower bound to
 *    `capturedAt - 60s` so the past minute is always included. Several
 *    adjacent shots will then share the same bar (the minute's totals).
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

export function onScreenHealthChange(listener: (health: CaptureHealth) => void): () => void {
  healthListeners.add(listener);
  return () => healthListeners.delete(listener);
}

function setScreenHealth(health: CaptureHealth): void {
  lastHealth = health;
  for (const listener of healthListeners) listener(health);
}

function getStore(): ScreenshotStore {
  if (store) return store;
  const db = new Database(path.join(app.getPath('userData'), 'agent.db'));
  store = new ScreenshotStore(db);
  return store;
}

/** Shared accessor so the uploader can drain the same local queue. */
export function getScreenshotStore(): ScreenshotStore {
  return getStore();
}

function schedule() {
  if (timer) clearTimeout(timer);
  // Read the live, server-driven cadence each time so a policy change applies
  // from the next scheduled shot onward.
  const delay = nextDelayMs(getScreenshotIntervalSec() * 1000);
  timer = setTimeout(() => void tick(), delay);
  log.info('next screenshot scheduled', { inMs: delay });
}

async function tick() {
  timer = null;
  try {
    const status = getTimerService().status();
    // Only capture while actively tracking (running and not paused).
    if (status.state === 'RUNNING' && !status.paused) {
      const { rows, health } = await captureNow(status.entryId);
      setScreenHealth(health);
      for (const r of rows) getStore().insert(r);
      // Push fresh shots to Cloudinary promptly (no-op if logged out/unconfigured).
      if (rows.length) void uploadScreenshotsNow(rows).finally(() => void drainUploads());
    }
  } catch (err) {
    log.warn('screenshot tick failed', { err: String(err) });
  } finally {
    schedule();
  }
}

export function rescheduleCaptureLoop(reason = 'config-change'): void {
  if (!timer) return;
  schedule();
  log.info('screenshot loop rescheduled', { reason });
}

function screenshotsRoot(): string {
  return path.join(app.getPath('userData'), 'screenshots');
}

/** All `.webp` files under the screenshots dir (one level of YYYY-MM-DD dirs). */
async function listWebpFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let dayDirs: string[];
  try {
    dayDirs = await fs.readdir(root);
  } catch {
    return out; // dir doesn't exist yet — nothing captured
  }
  for (const d of dayDirs) {
    const dayPath = path.join(root, d);
    try {
      if (!(await fs.stat(dayPath)).isDirectory()) continue;
      for (const f of await fs.readdir(dayPath)) {
        if (f.endsWith('.webp')) out.push(path.join(dayPath, f));
      }
    } catch {
      /* race with a concurrent delete — skip */
    }
  }
  return out;
}

/** Remove now-empty day directories (cosmetic; keeps the tree tidy). */
async function pruneEmptyDirs(root: string): Promise<void> {
  let dayDirs: string[];
  try {
    dayDirs = await fs.readdir(root);
  } catch {
    return;
  }
  for (const d of dayDirs) {
    const p = path.join(root, d);
    try {
      if ((await fs.stat(p)).isDirectory() && (await fs.readdir(p)).length === 0) {
        await fs.rmdir(p);
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Prune the local screenshot cache: expire old shots, delete orphan files
 * (crash between write and DB insert), and drop rows whose file vanished
 * (so the gallery never shows a broken thumbnail). Idempotent — safe to run
 * on every boot and daily thereafter.
 */
export async function runScreenshotRetention(now = Date.now()): Promise<void> {
  try {
    const root = screenshotsRoot();
    const filesOnDisk = await listWebpFiles(root);
    const rows = getStore().allForRetention();
    const plan = planScreenshotRetention({ rows, filesOnDisk, now, retentionDays: SCREENSHOT_RETENTION_DAYS });

    // Delete rows first: if we crash mid-unlink, the leftover files become
    // orphans the next run reaps — never dangling rows pointing at gone files.
    getStore().deleteByIds(plan.rowIdsToDelete);
    let unlinked = 0;
    for (const f of plan.filesToDelete) {
      try {
        await fs.unlink(f);
        unlinked++;
      } catch {
        /* already gone / locked — next run retries */
      }
    }
    await pruneEmptyDirs(root);

    if (plan.rowIdsToDelete.length || plan.filesToDelete.length) {
      log.info('screenshot retention', {
        expired: plan.expired,
        orphanFiles: plan.orphanFiles,
        danglingRows: plan.danglingRows,
        rowsDeleted: plan.rowIdsToDelete.length,
        filesUnlinked: unlinked,
      });
    }
  } catch (err) {
    log.warn('screenshot retention failed', { err: String(err) });
  }
}

/** Start the exact-cadence capture loop + the local-cache janitor. */
export function startCaptureLoop(): void {
  if (timer) return;
  getStore();
  void runScreenshotRetention(); // reap stale/orphan files on boot
  retentionTimer = setInterval(() => void runScreenshotRetention(), 24 * 60 * 60 * 1000);
  void retentionTimer;
  startUploader(); // drain the local queue to Cloudinary in the background
  schedule();
}

export async function recentScreenshots(limit: number): Promise<
  {
    id: string;
    capturedAt: number;
    thumb: string | null;
    uploadState: string;
    keyboardPct: number;
    mousePct: number;
    attempts: number;
    lastError: string | null;
  }[]
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
        attempts: r.attempts,
        lastError: r.lastError,
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
  const context = getWorkspaceTimeContext();
  return context.ready && context.dayStart !== null ? getStore().countSince(context.dayStart) : 0;
}

export function screenshotUploadSummary(): ScreenshotUploadSummary {
  return getStore().uploadSummary();
}

export async function retryFailedUploads(): Promise<{ reset: number }> {
  const reset = getStore().resetFailedUploads();
  if (reset > 0) await drainUploads();
  return { reset };
}

/** Capture immediately (manual "Take one now"). Forces the desktopCapturer
 *  call so macOS registers the app in Screen Recording even on first use. */
export async function captureOnce(): Promise<number> {
  const status = getTimerService().status();
  const { rows, health } = await captureNow(status.state === 'RUNNING' ? status.entryId : null, { force: true });
  setScreenHealth(health);
  for (const r of rows) getStore().insert(r);
  if (rows.length) {
    await uploadScreenshotsNow(rows);
    void drainUploads();
  }
  return rows.length;
}
