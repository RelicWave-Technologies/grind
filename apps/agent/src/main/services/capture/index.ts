import Database from 'better-sqlite3';
import { app, powerMonitor } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { ScreenshotStore, type CaptureOwner, type ScreenshotRow, type ScreenshotUploadSummary } from './store';
import { captureNow, thumbDataUrl, fullDataUrl } from './capture';
import { CAPTURE_DEFER_MS, nextDelayMs, shouldDeferCapture } from './scheduler';
import { planScreenshotRetention, type DiskFile } from './retention';
import { startUploader, uploadScreenshotsNow } from './uploader';
import { getTimerService } from '../timer';
import { getActivityStore } from '../activity';
import { activityPercent } from '../activity/percent';
import { SCREENSHOT_RETENTION_DAYS } from '../../env';
import { getScreenshotIntervalSec } from '../agentConfig';
import { type CaptureHealth } from '../permissions';
import { serverAlignedNow } from '../serverClock';
import { log } from '../../logger';
import { broadcastScreenshotChange } from './events';

let store: ScreenshotStore | null = null;
/** Keep the full-size local file this long after the server has it. */
const LOCAL_FULL_SIZE_DAYS = 3;
const DAY_MS = 86_400_000;
/** Long edge of the small local copy kept for the gallery once the full file goes. */
const TRIMMED_EDGE_PX = 480;
const TRIM_BATCH = 200;
/** A file this new may still be waiting for its row — never judge it an orphan. */
const ORPHAN_MIN_AGE_MS = 5 * 60_000;
let timer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
// How many times the pending capture has been held back for input.
let captureDeferrals = 0;
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

/** The account the timer is signed in as — every local row is scoped to it. */
function currentOwner(): CaptureOwner | null {
  try {
    return getTimerService().currentOwner();
  } catch {
    return null;
  }
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

function schedule(overrideDelayMs?: number) {
  if (timer) clearTimeout(timer);
  // Read the live, server-driven cadence each time so a policy change applies
  // from the next scheduled shot onward.
  const delay = overrideDelayMs ?? nextDelayMs(getScreenshotIntervalSec() * 1000);
  timer = setTimeout(() => void tick(), delay);
  log.info('next screenshot scheduled', { inMs: delay });
}

async function tick() {
  timer = null;
  try {
    const status = getTimerService().status();
    // Only capture while actively tracking (running and not paused).
    if (status.state === 'RUNNING' && !status.paused) {
      // Capturing blocks the process that owns every window. Wait for a gap in
      // input so the stutter lands where nobody is looking — bounded, so a
      // continuously-typing user still gets captured.
      if (shouldDeferCapture(powerMonitor.getSystemIdleTime(), captureDeferrals)) {
        captureDeferrals += 1;
        schedule(CAPTURE_DEFER_MS);
        return;
      }
      captureDeferrals = 0;
      const { rows: captured, health } = await captureNow(status.entryId);
      setScreenHealth(health);
      const owner = currentOwner();
      const rows = captured.map((r) => ({
        ...r,
        ownerUserId: owner?.userId ?? null,
        ownerWorkspaceId: owner?.workspaceId ?? null,
      }));
      for (const r of rows) getStore().insert(r);
      if (rows.length) broadcastScreenshotChange();
      // Push fresh shots promptly, through the same single pass the
      // background drain uses (no-op if signed out or storage is off).
      if (rows.length) void uploadScreenshotsNow(rows);
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

/** Where a stored (relative, or legacy absolute) screenshot path lives on disk. */
export function resolveScreenshotPath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(screenshotsRoot(), filePath);
}

/** All `.webp` files under the screenshots dir (one level of YYYY-MM-DD dirs). */
async function listWebpFiles(root: string): Promise<DiskFile[]> {
  const out: DiskFile[] = [];
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
        if (!f.endsWith('.webp')) continue;
        const filePath = path.join(dayPath, f);
        try {
          out.push({ path: filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs });
        } catch {
          /* deleted between readdir and stat */
        }
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
 * (so the gallery never shows a broken thumbnail). Then shrink uploaded shots
 * the server has held for a few days to a small local copy. Idempotent — safe
 * to run on every boot and daily thereafter.
 */
async function runScreenshotRetention(now = serverAlignedNow()): Promise<void> {
  try {
    const root = screenshotsRoot();
    // Rows BEFORE files: a capture racing this run writes its file first and
    // its row second, so a row read here always has its file on the listing
    // below. Reading the other way round dropped such a row as "dangling".
    const rows = getStore()
      .allForRetention()
      .map((r) => ({ ...r, filePath: resolveScreenshotPath(r.filePath) }));
    const filesOnDisk = await listWebpFiles(root);
    // eslint-disable-next-line no-restricted-syntax -- device<->device: compared with local file mtimes
    const youngerThan = Date.now() - ORPHAN_MIN_AGE_MS;
    const plan = planScreenshotRetention({
      rows,
      filesOnDisk: filesOnDisk.map((f) => f.path),
      // The same capture can also have written its file and not yet its row.
      protectedFiles: filesOnDisk.filter((f) => f.mtimeMs > youngerThan).map((f) => f.path),
      now,
      retentionDays: SCREENSHOT_RETENTION_DAYS,
    });

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
    const trimmed = await trimUploadedFiles();

    if (plan.rowIdsToDelete.length || plan.filesToDelete.length || trimmed) {
      log.info('screenshot retention', {
        expired: plan.expired,
        orphanFiles: plan.orphanFiles,
        danglingRows: plan.danglingRows,
        rowsDeleted: plan.rowIdsToDelete.length,
        filesUnlinked: unlinked,
        trimmed,
      });
    }
  } catch (err) {
    log.warn('screenshot retention failed', { err: String(err) });
  }
}

/**
 * Swap the full-size file of shots uploaded more than a few days ago for a
 * small copy, in place. The row stays (the gallery keeps its tile and its
 * activity bars); full resolution lives on the server. Shots not yet uploaded
 * are never touched — their file is the only copy.
 */
async function trimUploadedFiles(): Promise<number> {
  // eslint-disable-next-line no-restricted-syntax -- device<->device: compared with local upload times
  const at = Date.now();
  const rows = getStore().uploadedToTrim(at - LOCAL_FULL_SIZE_DAYS * DAY_MS, TRIM_BATCH);
  let trimmed = 0;
  for (const row of rows) {
    const file = resolveScreenshotPath(row.filePath);
    const tmp = `${file}.trim`;
    try {
      const small = await sharp(file)
        .resize({ width: TRIMMED_EDGE_PX, height: TRIMMED_EDGE_PX, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 70 })
        .toBuffer();
      await fs.writeFile(tmp, small, { mode: 0o600 });
      await fs.rename(tmp, file);
      getStore().markTrimmed(row.id, small.length, at);
      trimmed++;
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      // A missing file is retention's business (dangling row); anything else
      // is retried on the next run.
      if ((err as { code?: unknown }).code !== 'ENOENT') {
        log.debug('screenshot trim failed', { id: row.id, err: String(err) });
      }
    }
  }
  return trimmed;
}

/** Start the exact-cadence capture loop + the local-cache janitor. */
export function startCaptureLoop(): void {
  if (timer) return;
  getStore();
  void runScreenshotRetention(); // reap stale/orphan files on boot
  retentionTimer = setInterval(() => void runScreenshotRetention(), 24 * 60 * 60 * 1000);
  void retentionTimer;
  startUploader(); // drain the local queue to the upload target in the background
  schedule();
}

export interface ScreenshotListItem {
  id: string;
  capturedAt: number;
  uploadState: string;
  keyboardPct: number;
  mousePct: number;
  attempts: number;
  lastError: string | null;
}

const DEFAULT_ACTIVITY_WINDOW_MS = 30 * 60_000;

/**
 * For each shot (rows newest-first), when the same display was captured
 * before it — from the rows themselves, or `earlier` for the oldest row of each
 * display. Shots of other displays never count: they are taken at the same
 * instant, and treating one as "the previous shot" left an empty window.
 */
export function previousShotOnSameDisplay(
  rows: Array<Pick<ScreenshotRow, 'id' | 'displayId' | 'capturedAt'>>,
  earlier: (displayId: string, beforeMs: number) => number | null,
): Map<string, number | undefined> {
  const previousOnDisplay = new Map<string, number | null>();
  const olderOf = new Map<string, number | undefined>();
  for (const r of [...rows].reverse()) {
    if (!previousOnDisplay.has(r.displayId)) {
      previousOnDisplay.set(r.displayId, earlier(r.displayId, r.capturedAt));
    }
    olderOf.set(r.id, previousOnDisplay.get(r.displayId) ?? undefined);
    previousOnDisplay.set(r.displayId, r.capturedAt);
  }
  return olderOf;
}

/**
 * Gallery items with their per-shot activity bars.
 *
 * Each shot's window runs back to the previous shot of the SAME display. With
 * two monitors both captured at one instant, "the previous row" used to be the
 * other display's shot from the same moment — an empty window and 0% bars.
 */
function toListItems(owner: CaptureOwner, rows: ScreenshotRow[]): ScreenshotListItem[] {
  const activity = getActivityStore();
  try {
    activity.claimUnowned(owner);
  } catch {
    /* activity store unavailable — bars read 0 */
  }
  const olderOf = previousShotOnSameDisplay(rows, (displayId, beforeMs) =>
    getStore().previousCaptureOnDisplay(owner, displayId, beforeMs),
  );
  return rows.map((r) => {
    const { from, to } = activityWindowForShot({
      capturedAt: r.capturedAt,
      olderCapturedAt: olderOf.get(r.id),
      defaultWindowMs: DEFAULT_ACTIVITY_WINDOW_MS,
    });
    let keyboardPct = 0;
    let mousePct = 0;
    try {
      ({ keyboard: keyboardPct, mouse: mousePct } = activityPercent(activity.aggregate(from, to, owner)));
    } catch {
      /* activity store may be empty/unavailable */
    }
    return {
      id: r.id,
      capturedAt: r.capturedAt,
      uploadState: r.uploadState,
      attempts: r.attempts,
      lastError: r.lastError,
      keyboardPct,
      mousePct,
    };
  });
}

/** The signed-in account's newest shots. */
export async function recentScreenshots(limit: number): Promise<ScreenshotListItem[]> {
  const owner = currentOwner();
  if (!owner) return [];
  getStore().claimUnowned(owner);
  return toListItems(owner, getStore().recent(owner, limit));
}

/** Every shot the signed-in account captured in [from, to) — a whole day for the gallery. */
export async function screenshotsInRange(fromMs: number, toMs: number): Promise<ScreenshotListItem[]> {
  const owner = currentOwner();
  if (!owner || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  getStore().claimUnowned(owner);
  return toListItems(owner, getStore().inRange(owner, fromMs, toMs));
}

/** A row the signed-in account may look at, or null. */
function ownedRow(id: string): ScreenshotRow | null {
  const owner = currentOwner();
  const row = getStore().find(id);
  if (!owner || !row) return null;
  return row.ownerUserId === owner.userId && row.ownerWorkspaceId === owner.workspaceId ? row : null;
}

/** Lazily load one thumbnail after its gallery tile approaches the viewport. */
export async function thumbnailScreenshot(id: string): Promise<string | null> {
  const row = ownedRow(id);
  if (!row) return null;
  return thumbDataUrl(resolveScreenshotPath(row.filePath));
}

/** Full-resolution data URL for one screenshot (in-app lightbox). */
export async function fullScreenshot(id: string): Promise<string | null> {
  const row = ownedRow(id);
  if (!row) return null;
  return fullDataUrl(resolveScreenshotPath(row.filePath));
}

export function screenshotUploadSummary(): ScreenshotUploadSummary {
  return getStore().uploadSummary(currentOwner());
}
