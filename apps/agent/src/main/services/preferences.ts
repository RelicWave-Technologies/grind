import { app } from 'electron';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../logger';

/**
 * Local, user-scoped preferences — small UI choices that belong to the device,
 * not the account (floating-bar visibility + position). NOT secrets (those
 * live in tokenStore behind safeStorage) and NOT workspace policy (that's
 * server-owned). Just per-install chrome state.
 *
 * Design:
 *  - One JSON file in userData. Read ONCE synchronously at boot into an
 *    in-memory cache (the file is tiny and only touched at startup), then all
 *    reads are sync + free.
 *  - Writes are atomic (temp file + rename) and DEBOUNCED, so dragging the bar
 *    — which fires `moved` many times a second — never thrashes the disk.
 *  - A corrupt or partial file degrades to defaults rather than crashing the
 *    app: a bad preference must never wedge startup.
 *  - Listeners get notified on change so the window layer can react to a
 *    settings toggle without polling.
 */

export interface FloatingBarPreferences {
  /** User toggle — show the always-on-top mini bar while tracking. */
  visible: boolean;
  /** Last dragged position; null = use the default corner. */
  x: number | null;
  y: number | null;
}

export interface Preferences {
  floatingBar: FloatingBarPreferences;
}

const DEFAULTS: Preferences = {
  floatingBar: { visible: true, x: null, y: null },
};

let cache: Preferences | null = null;
const listeners = new Set<(prefs: Preferences) => void>();
let writeTimer: NodeJS.Timeout | null = null;

function filePath(): string {
  return path.join(app.getPath('userData'), 'preferences.json');
}

/** Merge a parsed (possibly partial / old) object over defaults defensively. */
function coerce(raw: unknown): Preferences {
  const r = (raw ?? {}) as Partial<Preferences>;
  const fb = (r.floatingBar ?? {}) as Partial<FloatingBarPreferences>;
  return {
    floatingBar: {
      visible: typeof fb.visible === 'boolean' ? fb.visible : DEFAULTS.floatingBar.visible,
      x: typeof fb.x === 'number' && Number.isFinite(fb.x) ? fb.x : null,
      y: typeof fb.y === 'number' && Number.isFinite(fb.y) ? fb.y : null,
    },
  };
}

/** Load once at boot (sync — file is tiny + only read at startup). */
function ensureLoaded(): Preferences {
  if (cache) return cache;
  try {
    const txt = readFileSync(filePath(), 'utf8');
    cache = coerce(JSON.parse(txt));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('preferences: unreadable, using defaults', { err: String(err) });
    }
    cache = { ...DEFAULTS, floatingBar: { ...DEFAULTS.floatingBar } };
  }
  return cache;
}

export function getPreferences(): Preferences {
  const c = ensureLoaded();
  // Hand back a structural copy so callers can't mutate the cache in place.
  return { floatingBar: { ...c.floatingBar } };
}

/**
 * Shallow-merge a partial update into the floating-bar prefs, persist
 * (debounced + atomic), and notify listeners synchronously.
 */
export function patchFloatingBar(patch: Partial<FloatingBarPreferences>): Preferences {
  const c = ensureLoaded();
  c.floatingBar = { ...c.floatingBar, ...patch };
  scheduleWrite();
  const snapshot = getPreferences();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (err) {
      log.warn('preferences: listener threw', { err: String(err) });
    }
  }
  return snapshot;
}

export function onPreferencesChange(fn: (prefs: Preferences) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flush();
  }, 250);
}

/** Atomic write: temp file + rename, so a crash mid-write never corrupts. */
async function flush(): Promise<void> {
  if (!cache) return;
  const target = filePath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    log.warn('preferences: write failed', { err: String(err) });
    void fs.unlink(tmp).catch(() => undefined);
  }
}

/** Flush any pending debounced write immediately (called on app quit). */
export async function flushPreferences(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  await flush();
}
