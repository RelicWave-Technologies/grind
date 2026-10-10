import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, crashReporter: {} }));
vi.mock('./logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { createGpuCrashGuard, GPU_CRASH_LIMIT } = await import('./crashHandling');

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timo-gpu-'));
  file = path.join(dir, 'gpu-safe-mode.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GPU crash guard', () => {
  it('keeps hardware acceleration on with no record', () => {
    expect(createGpuCrashGuard({ file, version: '1.0.0' }).shouldDisableAtBoot()).toBe(false);
  });

  it('turns acceleration off from the next boot after repeated GPU crashes', () => {
    const run = createGpuCrashGuard({ file, version: '1.0.0' });
    for (let i = 1; i < GPU_CRASH_LIMIT; i += 1) expect(run.noteGpuCrash()).toBe(false);
    expect(run.noteGpuCrash()).toBe(true);
    // Recorded once; further crashes change nothing.
    expect(run.noteGpuCrash()).toBe(false);

    expect(createGpuCrashGuard({ file, version: '1.0.0' }).shouldDisableAtBoot()).toBe(true);
  });

  it('gives a new version a fresh try', () => {
    const run = createGpuCrashGuard({ file, version: '1.0.0', limit: 1 });
    run.noteGpuCrash();
    expect(createGpuCrashGuard({ file, version: '1.0.1' }).shouldDisableAtBoot()).toBe(false);
  });

  it('reads a corrupt record as nothing recorded', () => {
    fs.writeFileSync(file, '{not json');
    expect(createGpuCrashGuard({ file, version: '1.0.0' }).shouldDisableAtBoot()).toBe(false);
  });

  it('never throws when the record cannot be written', () => {
    const run = createGpuCrashGuard({
      file,
      version: '1.0.0',
      limit: 1,
      fs: { readFileSync: fs.readFileSync, writeFileSync: () => { throw new Error('read-only'); } },
    });
    expect(run.noteGpuCrash()).toBe(true);
  });
});
