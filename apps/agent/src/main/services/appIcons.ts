import { app as electronApp } from 'electron';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
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
const execFileAsync = promisify(execFile);

type MacBundleInfo = {
  CFBundleIconFile?: unknown;
  CFBundleIconFiles?: unknown;
  CFBundleIconName?: unknown;
  CFBundleIcons?: {
    CFBundlePrimaryIcon?: {
      CFBundleIconFiles?: unknown;
      CFBundleIconName?: unknown;
    };
  };
};

export function macAppBundlePath(appPath: string): string | null {
  const normalized = normalize(appPath);
  const marker = `.app${sep}`;
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex >= 0) return normalized.slice(0, markerIndex + 4);
  return normalized.toLowerCase().endsWith('.app') ? normalized : null;
}

export function macIconFileNames(info: MacBundleInfo): string[] {
  const values: unknown[] = [
    info.CFBundleIconFile,
    info.CFBundleIconName,
    info.CFBundleIconFiles,
    info.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName,
    info.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles,
  ];
  const names = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  const safeNames = names
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => basename(value.trim()))
    .flatMap((value) => (extname(value) ? [value] : [`${value}.icns`]))
    .filter((value) => value.toLowerCase().endsWith('.icns'));
  return [...new Set(safeNames)];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveMacIconFile(appPath: string): Promise<string | null> {
  const bundlePath = macAppBundlePath(appPath);
  if (!bundlePath) return null;
  const resourcesPath = join(bundlePath, 'Contents', 'Resources');
  const infoPath = join(bundlePath, 'Contents', 'Info.plist');
  let declaredNames: string[] = [];
  try {
    const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath], {
      maxBuffer: 1_000_000,
    });
    declaredNames = macIconFileNames(JSON.parse(stdout) as MacBundleInfo);
  } catch (err) {
    log.warn('app icon metadata read failed', { appPath: bundlePath, err: String(err) });
  }

  for (const name of declaredNames) {
    const candidate = join(resourcesPath, name);
    if (await pathExists(candidate)) return candidate;
  }

  try {
    const fallback = (await readdir(resourcesPath))
      .filter((name) => name.toLowerCase().endsWith('.icns'))
      .sort((a, b) => a.localeCompare(b))[0];
    return fallback ? join(resourcesPath, fallback) : null;
  } catch {
    return null;
  }
}

async function extractMacIcon(appPath: string): Promise<Buffer | null> {
  const iconPath = await resolveMacIconFile(appPath);
  if (!iconPath) return null;
  const tempDir = await mkdtemp(join(tmpdir(), 'timo-app-icon-'));
  const pngPath = join(tempDir, 'icon.png');
  try {
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', iconPath, '--out', pngPath], {
      maxBuffer: 1_000_000,
    });
    return await sharp(pngPath)
      .resize(ICON_PX, ICON_PX, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      log.warn('app icon temporary file cleanup failed', { err: String(err) });
    }
  }
}

async function extractAppIcon(path: string): Promise<Buffer | null> {
  if (process.platform === 'darwin') return extractMacIcon(path);
  const img = await electronApp.getFileIcon(path, { size: 'normal' });
  if (img.isEmpty()) return null;
  const png = img.resize({ width: ICON_PX, height: ICON_PX }).toPNG();
  return png.length > 0 ? png : null;
}

export async function noteRunningApp(input: {
  app: string | null;
  bundleId: string | null;
  path: string | null;
}): Promise<void> {
  const { bundleId, path } = input;
  if (!bundleId || !path) return;
  if (uploaded.has(bundleId) || pending.has(bundleId)) return;
  try {
    const png = await extractAppIcon(path);
    if (!png) return;
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
