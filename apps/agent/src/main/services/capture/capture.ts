import { desktopCapturer, screen, app } from 'electron';
import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { SCREENSHOT_QUALITY, SCREENSHOT_MAX_EDGE } from '../../env';
import { hasScreenAccess } from '../permissions';
import { log } from '../../logger';
import type { ScreenshotRow } from './store';

function dayDir(now: number): string {
  return path.join(app.getPath('userData'), 'screenshots', new Date(now).toISOString().slice(0, 10));
}

/**
 * Capture every display NOW. Uses the whole-screen source (fullscreen-safe —
 * window sources break under fullscreen), re-encodes to high-quality WebP via
 * sharp, and writes one file per display. Returns rows to enqueue.
 */
export async function captureNow(timeEntryId: string | null): Promise<ScreenshotRow[]> {
  if (!hasScreenAccess()) {
    log.warn('screenshot skipped — no Screen Recording permission');
    return [];
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: SCREENSHOT_MAX_EDGE, height: SCREENSHOT_MAX_EDGE },
  });

  const now = Date.now();
  const dir = dayDir(now);
  await fs.mkdir(dir, { recursive: true });

  const rows: ScreenshotRow[] = [];
  for (const s of sources) {
    if (s.thumbnail.isEmpty()) continue; // blank/black = permission lost mid-session
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
    });
  }
  log.info('captured screenshots', { count: rows.length, displays: screen.getAllDisplays().length });
  return rows;
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
