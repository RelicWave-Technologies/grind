import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimLaunchInstall, claimMachineInstallNotice, createUpdateMemory } from './memory';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timo-update-memory-'));
  file = path.join(dir, 'update-state.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('update memory', () => {
  it('shows the machine-install notice once per install, across restarts', () => {
    const exe = 'C:\\Program Files\\Timo\\Timo.exe';
    expect(claimMachineInstallNotice(createUpdateMemory(file), exe)).toBe(true);
    // A fresh store is a fresh process reading the same userData file.
    expect(claimMachineInstallNotice(createUpdateMemory(file), exe)).toBe(false);
    expect(claimMachineInstallNotice(createUpdateMemory(file), 'c:\\program files\\timo\\timo.exe')).toBe(false);
  });

  it('shows it again for a different install path', () => {
    const store = createUpdateMemory(file);
    expect(claimMachineInstallNotice(store, 'C:\\Program Files\\Timo\\Timo.exe')).toBe(true);
    expect(claimMachineInstallNotice(store, 'C:\\Program Files\\Grind\\Timo\\Timo.exe')).toBe(true);
  });

  it('never shows the notice when it cannot be recorded', () => {
    const failing = createUpdateMemory(file, {
      readFileSync: () => { throw new Error('ENOENT'); },
      writeFileSync: () => { throw new Error('EPERM'); },
      renameSync: () => undefined,
    });
    expect(claimMachineInstallNotice(failing, 'C:\\Program Files\\Timo\\Timo.exe')).toBe(false);
  });

  it('allows one launch-time install per version', () => {
    const store = createUpdateMemory(file);
    expect(claimLaunchInstall(store, '0.0.2-beta.39')).toBe(true);
    expect(claimLaunchInstall(createUpdateMemory(file), '0.0.2-beta.39')).toBe(false);
    expect(claimLaunchInstall(store, '0.0.2-beta.40')).toBe(true);
  });

  it('keeps one decision when recording the other', () => {
    const store = createUpdateMemory(file);
    claimMachineInstallNotice(store, 'C:\\Program Files\\Timo\\Timo.exe');
    claimLaunchInstall(store, '0.0.2-beta.39');
    expect(store.read()).toEqual({
      machineInstallNoticeFor: 'c:\\program files\\timo\\timo.exe',
      launchInstallTriedFor: '0.0.2-beta.39',
    });
  });

  it('reads a corrupt file as empty', () => {
    fs.writeFileSync(file, '{not json');
    expect(createUpdateMemory(file).read()).toEqual({ machineInstallNoticeFor: null, launchInstallTriedFor: null });
  });
});
