import { app as electronApp } from 'electron';
import { api } from './apiClient';
import { log } from '../logger';

/**
 * Extracts the real OS icon for each running app the tracker sees and uploads
 * it to the backend (keyed by bundle id), so the dashboard's app-usage panel
 * shows true app icons instead of letters.
 *
 * Dedup is per-session: each bundle is extracted + uploaded at most once per run
 * (the backend upsert is idempotent). Uploads are batched + retried so a flaky
 * network never loses an icon or blocks the capture loop.
 */
const uploaded = new Set<string>(); // bundles confirmed stored this session
const pending = new Map<string, { app: string; pngBase64: string }>();
let flushTimer: NodeJS.Timeout | null = null;
const ICON_PX = 44;
const FLUSH_DELAY_MS = 4000;
const MAX_BATCH = 50;

export async function noteRunningApp(input: {
  app: string | null;
  bundleId: string | null;
  path: string | null;
}): Promise<void> {
  const { bundleId, path } = input;
  if (!bundleId || !path) return;
  if (uploaded.has(bundleId) || pending.has(bundleId)) return;
  try {
    const img = await electronApp.getFileIcon(path, { size: 'normal' });
    if (img.isEmpty()) return;
    const png = img.resize({ width: ICON_PX, height: ICON_PX }).toPNG();
    if (png.length === 0) return;
    pending.set(bundleId, { app: input.app ?? bundleId, pngBase64: png.toString('base64') });
    scheduleFlush();
  } catch (err) {
    log.warn('app icon extract failed', { bundleId, err: String(err) });
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    void flush();
  }, FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (pending.size === 0) return;
  const batch = [...pending.entries()]
    .slice(0, MAX_BATCH)
    .map(([bundleId, v]) => ({ bundleId, app: v.app, pngBase64: v.pngBase64 }));
  try {
    await api('/v1/agent/app-icons', { method: 'POST', body: { icons: batch } });
    for (const it of batch) {
      uploaded.add(it.bundleId);
      pending.delete(it.bundleId);
    }
    if (pending.size > 0) scheduleFlush(); // more than one batch waiting
  } catch (err) {
    log.warn('app icon upload failed — will retry', { err: String(err) });
    scheduleFlush();
  }
}
