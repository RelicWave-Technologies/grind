import { desktopCapturer, screen, app } from 'electron';
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { SCREENSHOT_QUALITY, SCREENSHOT_MAX_EDGE } from '../../env';
import { hasScreenAccess, type CaptureHealth } from '../permissions';
import { log } from '../../logger';
import type { ScreenshotRow } from './store';

export interface CaptureResult {
  rows: ScreenshotRow[];
  health: CaptureHealth;
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
  const dir = dayDir(now);
  await fs.mkdir(dir, { recursive: true });

  let sawEmpty = false;
  const rows: ScreenshotRow[] = [];
  for (const s of sources) {
    if (s.thumbnail.isEmpty()) {
      sawEmpty = true; // blank/black frame = permission lost mid-session (revocation tell)
      continue;
    }
    const webp = await sharp(s.thumbnail.toPNG())
      .resize({ width: SCREENSHOT_MAX_EDGE, height: SCREENSHOT_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: SCREENSHOT_QUALITY })
      .toBuffer();
    const id = ulid();
    const filePath = path.join(dir, `${id}.webp`);
    await fs.writeFile(filePath, webp, { mode: 0o600 });
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
  log.info('captured screenshots', { count: rows.length, displays: screen.getAllDisplays().length });
  const health: CaptureHealth = rows.length > 0 ? 'ok' : sawEmpty ? 'empty' : 'error';
  return { rows, health };
}

/** Read a stored screenshot and return a small base64 WebP thumbnail data URL. */
export async function thumbDataUrl(filePath: string, edge = 220): Promise<string | null> {
  try {
    const buf = await sharp(filePath).resize({ width: edge, height: edge, fit: 'inside' }).webp({ quality: 70 }).toBuffer();
    return `data:image/webp;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
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
