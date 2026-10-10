import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackingReadiness } from '../../shared/tracking';

vi.mock('electron', () => ({ app: {} }));

const { createPermissionRelaunchMemory, permissionRelaunchVerdict, PERMISSION_RELAUNCH_WINDOW_MS } = await import('./permissionRelaunch');

function readiness(patch: Partial<TrackingReadiness> = {}): TrackingReadiness {
  return {
    ready: false,
    checkedAt: '2026-10-10T00:00:00.000Z',
    screenRecording: 'FAILED',
    accessibility: 'READY',
    blockingCapabilities: ['SCREEN_RECORDING'],
    ...patch,
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timo-relaunch-'));
  file = path.join(dir, 'permission-relaunch.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('permission relaunch memory', () => {
  it('records only the capabilities that were not ready', () => {
    expect(permissionRelaunchVerdict(readiness())).toEqual(['screen:FAILED']);
    expect(permissionRelaunchVerdict(readiness({ accessibility: 'NEEDS_GRANT' }))).toEqual(['screen:FAILED', 'accessibility:NEEDS_GRANT']);
    expect(permissionRelaunchVerdict(readiness({ ready: true, screenRecording: 'READY' }))).toEqual([]);
  });

  it('hands the record to the boot that follows the restart', () => {
    const before = createPermissionRelaunchMemory({ file, now: () => 1_000_000, processStartedAt: 0 });
    expect(before.remember(readiness())).toBe(true);

    const after = createPermissionRelaunchMemory({ file, now: () => 1_010_000, processStartedAt: 1_008_000 });
    expect(after.forThisBoot()).toEqual({ verdict: ['screen:FAILED'], relaunchedAt: 1_000_000 });
  });

  it('ignores a restart from longer ago than the window', () => {
    createPermissionRelaunchMemory({ file, now: () => 1_000_000, processStartedAt: 0 }).remember(readiness());
    const later = createPermissionRelaunchMemory({
      file,
      now: () => 0,
      processStartedAt: 1_000_000 + PERMISSION_RELAUNCH_WINDOW_MS + 1,
    });
    expect(later.forThisBoot()).toBeNull();
  });

  it('ignores a record written after this process started (the clock went back, or this process wrote it)', () => {
    createPermissionRelaunchMemory({ file, now: () => 1_000_000, processStartedAt: 0 }).remember(readiness());
    expect(createPermissionRelaunchMemory({ file, now: () => 0, processStartedAt: 999_000 }).forThisBoot()).toBeNull();
  });

  it('writes nothing when nothing was blocked', () => {
    const memory = createPermissionRelaunchMemory({ file, now: () => 1, processStartedAt: 0 });
    expect(memory.remember(readiness({ ready: true, screenRecording: 'READY', blockingCapabilities: [] }))).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reads a missing or corrupt file as no restart', () => {
    expect(createPermissionRelaunchMemory({ file, now: () => 0, processStartedAt: 0 }).forThisBoot()).toBeNull();
    fs.writeFileSync(file, '{"verdict":"screen:FAILED"}');
    expect(createPermissionRelaunchMemory({ file, now: () => 0, processStartedAt: 0 }).forThisBoot()).toBeNull();
  });
});
