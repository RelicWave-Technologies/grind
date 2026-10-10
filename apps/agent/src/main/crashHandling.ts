import fs from 'node:fs';
import path from 'node:path';
import { app, crashReporter } from 'electron';
import type { Details } from 'electron';
import { log } from './logger';

/**
 * Crashes used to leave no trace: no minidumps, and a GPU or utility process
 * dying was not even logged. Native crash dumps now stay on disk (never
 * uploaded) next to the logs, every child process that goes away is logged
 * with its reason and exit code, and a GPU process that keeps crashing — old
 * Intel Macs and some Windows drivers do — switches hardware acceleration off
 * from the next launch on. Timo's UI is a few small windows; software
 * rendering costs nothing a person would notice, a crashing GPU process can
 * take every window down with it.
 */

/** GPU process crashes in one run before acceleration goes off next boot. */
export const GPU_CRASH_LIMIT = 3;

type FsLike = Pick<typeof fs, 'readFileSync' | 'writeFileSync'>;

interface GpuSafeModeRecord {
  disableHardwareAcceleration: boolean;
  /** App version that recorded it: a new version (new Electron) gets a fresh try. */
  version: string;
}

export function createGpuCrashGuard(opts: { file: string; version: string; limit?: number; fs?: FsLike }) {
  const fsImpl = opts.fs ?? fs;
  const limit = opts.limit ?? GPU_CRASH_LIMIT;
  let crashes = 0;
  let recorded = false;

  function read(): GpuSafeModeRecord | null {
    try {
      const raw = JSON.parse(String(fsImpl.readFileSync(opts.file, 'utf8'))) as Partial<GpuSafeModeRecord>;
      return typeof raw.disableHardwareAcceleration === 'boolean' && typeof raw.version === 'string'
        ? { disableHardwareAcceleration: raw.disableHardwareAcceleration, version: raw.version }
        : null;
    } catch {
      return null;
    }
  }

  /** Whether this boot should run without hardware acceleration. */
  function shouldDisableAtBoot(): boolean {
    const record = read();
    return !!record && record.disableHardwareAcceleration && record.version === opts.version;
  }

  /** Count a GPU process crash; returns true when this one tripped the limit. */
  function noteGpuCrash(): boolean {
    crashes += 1;
    if (recorded || crashes < limit) return false;
    recorded = true;
    try {
      fsImpl.writeFileSync(opts.file, `${JSON.stringify({ disableHardwareAcceleration: true, version: opts.version })}\n`);
    } catch {
      // Only the safe mode is lost; the crash itself is already logged.
    }
    return true;
  }

  return { shouldDisableAtBoot, noteGpuCrash };
}

let guard: ReturnType<typeof createGpuCrashGuard> | null = null;

function gpuGuard(): ReturnType<typeof createGpuCrashGuard> {
  if (!guard) {
    guard = createGpuCrashGuard({
      file: path.join(app.getPath('userData'), 'gpu-safe-mode.json'),
      version: app.getVersion(),
    });
  }
  return guard;
}

/**
 * Must run before `ready`: crash dumps for the earliest crashes, and
 * disableHardwareAcceleration() has no effect once the app is ready.
 */
export function setUpCrashHandlingBeforeReady(): void {
  try {
    crashReporter.start({ uploadToServer: false });
  } catch (err) {
    log.warn('crash reporter could not start', { err: String(err) });
  }
  try {
    if (gpuGuard().shouldDisableAtBoot()) {
      app.disableHardwareAcceleration();
      log.warn('hardware acceleration disabled after repeated GPU process crashes', { version: app.getVersion() });
    }
  } catch (err) {
    log.warn('gpu safe mode check failed', { err: String(err) });
  }
}

/** Log every child process that goes away; count GPU crashes. */
export function registerChildProcessCrashLogging(): void {
  app.on('child-process-gone', (_event, details: Details) => {
    const crashed = details.reason !== 'clean-exit';
    const meta = {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName ?? null,
      name: details.name ?? null,
    };
    if (!crashed) {
      log.debug('child process exited', meta);
      return;
    }
    log.error('child process gone', meta);
    if (details.type === 'GPU' && gpuGuard().noteGpuCrash()) {
      log.error('GPU process keeps crashing; hardware acceleration goes off from the next launch', {
        limit: GPU_CRASH_LIMIT,
      });
    }
  });
}
