import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { TrackingReadiness } from '../../shared/tracking';
import { permissionVerdictToken, type PermissionRelaunchRecord } from '../../shared/permissionRelaunch';

/**
 * The permission-restart loop breaker. A "Restart Timo" pressed for a verdict
 * is recorded on disk before the relaunch; if this boot comes up within a
 * couple of minutes of it and shows the same verdict, the restart did not
 * help, and the UI offers the remove-and-re-add guidance instead of the same
 * restart again. Never relaunches anything itself.
 *
 * Tiny JSON file in userData, written synchronously (the process exits right
 * after). A missing or corrupt file reads as "no restart"; a failed write only
 * loses the loop breaker.
 */
export const PERMISSION_RELAUNCH_WINDOW_MS = 2 * 60_000;

type FsLike = Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'renameSync'>;

export function permissionRelaunchVerdict(readiness: TrackingReadiness): string[] {
  const verdict: string[] = [];
  if (readiness.screenRecording !== 'READY' && readiness.screenRecording !== 'NOT_REQUIRED') {
    verdict.push(permissionVerdictToken('screen', readiness.screenRecording));
  }
  if (readiness.accessibility !== 'READY' && readiness.accessibility !== 'NOT_REQUIRED') {
    verdict.push(permissionVerdictToken('accessibility', readiness.accessibility));
  }
  return verdict;
}

function parse(raw: unknown): PermissionRelaunchRecord | null {
  const r = (raw ?? {}) as Partial<PermissionRelaunchRecord>;
  if (!Array.isArray(r.verdict) || typeof r.relaunchedAt !== 'number' || !Number.isFinite(r.relaunchedAt)) return null;
  const verdict = r.verdict.filter((v): v is string => typeof v === 'string');
  return verdict.length ? { verdict, relaunchedAt: r.relaunchedAt } : null;
}

export function createPermissionRelaunchMemory(opts: {
  file: string;
  /** Device clock. */
  now: () => number;
  /** Device-clock time this process started. */
  processStartedAt: number;
  fs?: FsLike;
}) {
  const fsImpl = opts.fs ?? fs;
  let loaded = false;
  let current: PermissionRelaunchRecord | null = null;

  /** Record the verdict a restart is about to be tried for. */
  function remember(readiness: TrackingReadiness): boolean {
    const verdict = permissionRelaunchVerdict(readiness);
    if (!verdict.length) return false;
    try {
      const temp = `${opts.file}.tmp`;
      fsImpl.writeFileSync(temp, `${JSON.stringify({ verdict, relaunchedAt: opts.now() })}\n`);
      fsImpl.renameSync(temp, opts.file);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The restart that led to this process, if there was one: recorded no more
   * than the window before this process started. Read once per process.
   */
  function forThisBoot(): PermissionRelaunchRecord | null {
    if (loaded) return current;
    loaded = true;
    try {
      const record = parse(JSON.parse(String(fsImpl.readFileSync(opts.file, 'utf8'))));
      // device<->device: both readings are this machine's clock.
      const gap = record ? opts.processStartedAt - record.relaunchedAt : Number.NaN;
      current = record && gap >= 0 && gap <= PERMISSION_RELAUNCH_WINDOW_MS ? record : null;
    } catch {
      current = null;
    }
    return current;
  }

  return { remember, forThisBoot };
}

let singleton: ReturnType<typeof createPermissionRelaunchMemory> | null = null;

export function getPermissionRelaunchMemory() {
  if (!singleton) {
    singleton = createPermissionRelaunchMemory({
      file: path.join(app.getPath('userData'), 'permission-relaunch.json'),
      now: () => Date.now(),
      processStartedAt: Date.now() - process.uptime() * 1000,
    });
  }
  return singleton;
}
