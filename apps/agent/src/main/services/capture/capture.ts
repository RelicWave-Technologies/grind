import { desktopCapturer, screen, app } from 'electron';
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { availableParallelism } from 'node:os';
import { SCREENSHOT_QUALITY, SCREENSHOT_MAX_EDGE } from '../../env';
import { hasScreenAccess, type CaptureHealth } from '../permissions';
import { log } from '../../logger';
import type { ScreenshotRow } from './store';
import { AsyncLru } from './asyncLru';

const THUMBNAIL_CACHE_ENTRIES = 128;
const thumbnailCache = new AsyncLru<string>(THUMBNAIL_CACHE_ENTRIES);

// Screenshot work is infrequent and latency-insensitive. Bounding libvips keeps
// a multi-display capture from consuming every CPU core on low-end laptops.
sharp.concurrency(Math.max(1, Math.min(2, availableParallelism())));
sharp.cache({ memory: 32, files: 0, items: 64 });

export interface CaptureResult {
  rows: ScreenshotRow[];
  health: CaptureHealth;
}

/** Permission/readiness probe. It never writes, uploads, or retains pixels. */
export async function probeScreenCapture(): Promise<CaptureHealth> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 64, height: 64 },
      fetchWindowIcons: false,
    });
    if (sources.some((source) => !source.thumbnail.isEmpty())) return 'ok';
    return sources.length > 0 ? 'empty' : 'error';
  } catch {
    return hasScreenAccess() ? 'error' : 'no-permission';
  }
}

function dayDir(now: number): string {
  return path.join(app.getPath('userData'), 'screenshots', new Date(now).toISOString().slice(0, 10));
}

/**
 * Capture every display NOW. Uses the whole-screen source (fullscreen-safe —
 * window sources break under fullscreen), re-encodes to high-quality WebP via
 * sharp, writes one file per display, and reports a health signal so callers
 * can distinguish "no permission" from "granted but blank" (revocation).
 */
export async function captureNow(
  timeEntryId: string | null,
  opts: { force?: boolean } = {},
): Promise<CaptureResult> {
  // `force` calls desktopCapturer even without prior permission — the first
  // such call is what makes macOS register the app in the Screen Recording
  // list (and prompt). The scheduled loop stays gated to avoid needless calls.
  if (!opts.force && !hasScreenAccess()) {
    return { rows: [], health: 'no-permission' };
  }

  const startedAt = performance.now();
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: SCREENSHOT_MAX_EDGE, height: SCREENSHOT_MAX_EDGE },
    });
  } catch {
    // The attempt itself registers the app in macOS System Settings. Fail soft.
    log.warn('screenshot capture failed — likely missing Screen Recording permission');
    return { rows: [], health: hasScreenAccess() ? 'error' : 'no-permission' };
  }

  const now = Date.now();
  const sourceMs = performance.now() - startedAt;
  const dir = dayDir(now);
  await fs.mkdir(dir, { recursive: true });

  let sawEmpty = false;
  let transformMs = 0;
  let writeMs = 0;
  const rows: ScreenshotRow[] = [];
  for (const s of sources) {
    if (s.thumbnail.isEmpty()) {
      sawEmpty = true; // blank/black frame = permission lost mid-session (revocation tell)
      continue;
    }
    const transformStartedAt = performance.now();
    const webp = await sharp(s.thumbnail.toPNG())
      .resize({ width: SCREENSHOT_MAX_EDGE, height: SCREENSHOT_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: SCREENSHOT_QUALITY })
      .toBuffer();
    transformMs += performance.now() - transformStartedAt;
    const id = ulid();
    const filePath = path.join(dir, `${id}.webp`);
    const writeStartedAt = performance.now();
    await fs.writeFile(filePath, webp, { mode: 0o600 });
    writeMs += performance.now() - writeStartedAt;
    const size = s.thumbnail.getSize();
    rows.push({
      id,
      timeEntryId,
      displayId: s.display_id || String(s.id),
      capturedAt: now,
      filePath,
      bytes: webp.length,
      width: size.width,
      height: size.height,
      uploadState: 'pending',
      attempts: 0,
      s3Key: null,
      lastError: null,
      nextAttemptAt: null,
      failedAt: null,
    });
  }
  log.info('captured screenshots', {
    count: rows.length,
    displays: screen.getAllDisplays().length,
    sourceMs: Math.round(sourceMs),
    transformMs: Math.round(transformMs),
    writeMs: Math.round(writeMs),
    totalMs: Math.round(performance.now() - startedAt),
  });
  const health: CaptureHealth = rows.length > 0 ? 'ok' : sawEmpty ? 'empty' : 'error';
  return { rows, health };
}

/** Read a stored screenshot and return a small base64 WebP thumbnail data URL. */
export async function thumbDataUrl(filePath: string, edge = 220): Promise<string | null> {
  return thumbnailCache.get(`${filePath}:${edge}`, async () => {
    try {
      const buf = await sharp(filePath).resize({ width: edge, height: edge, fit: 'inside' }).webp({ quality: 70 }).toBuffer();
      return `data:image/webp;base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });
}

/** Full-resolution screenshot as a data URL (for the in-app lightbox). Capped to
 *  a sane long edge so the data URL isn't huge. */
export async function fullDataUrl(filePath: string, maxEdge = 1600): Promise<string | null> {
  try {
    const buf = await sharp(filePath).resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    return `data:image/webp;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}
