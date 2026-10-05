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
  /**
   * Lark task guid the user last tracked against, so reopening Timo offers the
   * work they were actually on. Boot deliberately closes any open entry (see
   * initTimerOnBoot), so the running timer can never carry this across a
   * restart — without it the picker fell back to whichever task happened to
   * sort first, quietly pre-selecting the WRONG task to start next.
   */
  lastLarkTaskGuid: string | null;
}

const DEFAULTS: Preferences = {
  floatingBar: { visible: true, x: null, y: null },
  lastLarkTaskGuid: null,
};

/**
 * What is on disk. The last task is remembered per account: on a shared
 * machine one person's last Lark task must never be pre-selected for the next.
 * `lastLarkTaskGuid` survives only as the slot an install wrote before tasks
 * were scoped (and the one used while nobody is signed in); the first owner
 * bound at boot claims it.
 */
interface StoredPreferences {
  floatingBar: FloatingBarPreferences;
  lastLarkTaskGuid: string | null;
  lastLarkTaskByOwner: Record<string, string>;
}

export type PreferencesOwner = { userId: string; workspaceId: string };

let cache: StoredPreferences | null = null;
let ownerKey: string | null = null;
const listeners = new Set<(prefs: Preferences) => void>();
let writeTimer: NodeJS.Timeout | null = null;
/** Writes run one at a time: two flushes sharing one temp path could rename a half-written file. */
let writeChain: Promise<void> = Promise.resolve();
let tempSequence = 0;

function filePath(): string {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function isGuid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Merge a parsed (possibly partial / old) object over defaults defensively. */
function coerce(raw: unknown): StoredPreferences {
  const r = (raw ?? {}) as Partial<StoredPreferences>;
  const byOwnerRaw = r.lastLarkTaskByOwner && typeof r.lastLarkTaskByOwner === 'object' ? r.lastLarkTaskByOwner : {};
  const lastLarkTaskByOwner: Record<string, string> = {};
  for (const [key, guid] of Object.entries(byOwnerRaw)) {
    if (isGuid(guid)) lastLarkTaskByOwner[key] = guid;
  }
  const fb = (r.floatingBar ?? {}) as Partial<FloatingBarPreferences>;
  return {
    floatingBar: {
      visible: typeof fb.visible === 'boolean' ? fb.visible : DEFAULTS.floatingBar.visible,
      x: typeof fb.x === 'number' && Number.isFinite(fb.x) ? fb.x : null,
      y: typeof fb.y === 'number' && Number.isFinite(fb.y) ? fb.y : null,
    },
    lastLarkTaskGuid: isGuid(r.lastLarkTaskGuid) ? r.lastLarkTaskGuid : null,
    lastLarkTaskByOwner,
  };
}

/** Load once at boot (sync — file is tiny + only read at startup). */
function ensureLoaded(): StoredPreferences {
  if (cache) return cache;
  try {
    const txt = readFileSync(filePath(), 'utf8');
    cache = coerce(JSON.parse(txt));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('preferences: unreadable, using defaults', { err: String(err) });
    }
    cache = { ...DEFAULTS, floatingBar: { ...DEFAULTS.floatingBar }, lastLarkTaskByOwner: {} };
  }
  return cache;
}

function keyFor(owner: PreferencesOwner): string {
  return `${owner.userId}:${owner.workspaceId}`;
}

function lastTaskFor(c: StoredPreferences): string | null {
  return ownerKey === null ? c.lastLarkTaskGuid : c.lastLarkTaskByOwner[ownerKey] ?? null;
}

/**
 * Scope per-account preferences to the signed-in session. `claimLegacy` (boot
 * only) hands an unscoped remembered task to this owner, once.
 */
export function setPreferencesOwner(owner: PreferencesOwner | null, opts: { claimLegacy?: boolean } = {}): void {
  const nextKey = owner ? keyFor(owner) : null;
  const c = ensureLoaded();
  if (nextKey !== null && opts.claimLegacy && c.lastLarkTaskGuid !== null) {
    if (!(nextKey in c.lastLarkTaskByOwner)) c.lastLarkTaskByOwner[nextKey] = c.lastLarkTaskGuid;
    c.lastLarkTaskGuid = null;
    scheduleWrite();
  }
  if (nextKey === ownerKey) return;
  ownerKey = nextKey;
  notify();
}

export function getPreferences(): Preferences {
  const c = ensureLoaded();
  // Hand back a structural copy so callers can't mutate the cache in place.
  return {
    floatingBar: { ...c.floatingBar },
    lastLarkTaskGuid: lastTaskFor(c),
  };
}

function notify(): Preferences {
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

/**
 * Shallow-merge a partial update into the floating-bar prefs, persist
 * (debounced + atomic), and notify listeners synchronously.
 */
export function patchFloatingBar(patch: Partial<FloatingBarPreferences>): Preferences {
  const c = ensureLoaded();
  c.floatingBar = { ...c.floatingBar, ...patch };
  scheduleWrite();
  return notify();
}

/**
 * Remember the task the user is tracking. Called on every start so the choice
 * survives a quit, a crash, or an update — no-op when it hasn't changed, to
 * keep the debounced write off the 1s timer tick.
 */
export function rememberLastLarkTask(guid: string | null): Preferences {
  const c = ensureLoaded();
  if (lastTaskFor(c) === guid) return getPreferences();
  if (ownerKey === null) c.lastLarkTaskGuid = guid;
  else if (guid === null) delete c.lastLarkTaskByOwner[ownerKey];
  else c.lastLarkTaskByOwner[ownerKey] = guid;
  scheduleWrite();
  return notify();
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

/**
 * Atomic write: temp file + rename, so a crash mid-write never corrupts.
 *
 * Serialized, and each write snapshots the cache when its turn comes. The
 * debounced write and the quit flush used to run concurrently through the
 * same temp path: one rename could move the other's half-written file into
 * place, or fail with ENOENT and leave the older contents on disk.
 */
function flush(): Promise<void> {
  const run = writeChain.then(writeOnce, writeOnce);
  writeChain = run;
  return run;
}

async function writeOnce(): Promise<void> {
  if (!cache) return;
  const target = filePath();
  tempSequence += 1;
  const tmp = `${target}.${process.pid}.${tempSequence}.tmp`;
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
