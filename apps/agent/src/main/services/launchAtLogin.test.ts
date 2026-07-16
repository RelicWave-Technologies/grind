import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginItemSettings } from 'electron';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
    isInApplicationsFolder: vi.fn(),
    moveToApplicationsFolder: vi.fn(),
  },
}));

vi.mock('electron', () => ({ app: mocks.app }));

import { createLaunchAtLoginService, isHiddenLaunch } from './launchAtLogin';

function settings(patch: Partial<LoginItemSettings> = {}): LoginItemSettings {
  return {
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAtLogin: false,
    wasOpenedAsHidden: false,
    restoreState: false,
    status: 'not-registered',
    executableWillLaunchAtLogin: false,
    launchItems: [],
    ...patch,
  };
}

function item(patch: Partial<LoginItemSettings['launchItems'][number]> = {}): LoginItemSettings['launchItems'][number] {
  return {
    name: 'Timo',
    path: 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe',
    args: ['--hidden'],
    scope: 'user',
    enabled: true,
    ...patch,
  };
}

function service(platform: NodeJS.Platform, execPath: string, argv: string[] = []) {
  return createLaunchAtLoginService({
    app: mocks.app,
    platform,
    execPath,
    argv,
    now: () => Date.parse('2026-07-12T00:00:00.000Z'),
  });
}

describe('launch at login service', () => {
  beforeEach(() => {
    mocks.app.isPackaged = true;
    mocks.app.getLoginItemSettings.mockReset();
    mocks.app.setLoginItemSettings.mockReset();
    mocks.app.isInApplicationsFolder.mockReset().mockReturnValue(true);
    mocks.app.moveToApplicationsFolder.mockReset().mockReturnValue(true);
  });

  it('recognizes only the explicit hidden startup argument', () => {
    expect(isHiddenLaunch(['Timo.exe', '--hidden'])).toBe(true);
    expect(isHiddenLaunch(['Timo.exe', 'timo://callback'])).toBe(false);
  });

  it('is unavailable without mutating login items in dev mode', () => {
    mocks.app.isPackaged = false;

    expect(service('darwin', '/Applications/Timo.app/Contents/MacOS/Timo').reconcileOnBoot()).toMatchObject({
      required: false,
      ready: false,
      state: 'UNAVAILABLE',
    });
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('requires installation when a packaged mac app is outside Applications', () => {
    mocks.app.isInApplicationsFolder.mockReturnValue(false);
    mocks.app.getLoginItemSettings.mockReturnValue(settings());

    expect(service('darwin', '/Volumes/Timo/Timo.app/Contents/MacOS/Timo').inspect()).toMatchObject({
      state: 'NEEDS_INSTALL',
      remediation: 'MOVE_TO_APPLICATIONS',
      canRepair: false,
    });
  });

  it('registers a missing macOS main app service on boot and verifies it', () => {
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(settings({ wasOpenedAtLogin: false }))
      .mockReturnValueOnce(settings())
      .mockReturnValueOnce(settings({ openAtLogin: true, status: 'enabled' }));

    const health = service('darwin', '/Applications/Timo.app/Contents/MacOS/Timo').reconcileOnBoot();

    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, type: 'mainAppService' });
    expect(health).toMatchObject({ ready: true, state: 'READY' });
  });

  it('surfaces macOS approval without silently overriding it', () => {
    mocks.app.getLoginItemSettings.mockReturnValue(settings({ openAtLogin: true, status: 'requires-approval' }));

    const health = service('darwin', '/Applications/Timo.app/Contents/MacOS/Timo').reconcileOnBoot();

    expect(health).toMatchObject({ state: 'NEEDS_APPROVAL', remediation: 'OPEN_LOGIN_ITEMS' });
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('captures macOS login origin before registration changes', () => {
    mocks.app.getLoginItemSettings.mockReturnValue(settings({ openAtLogin: true, status: 'enabled', wasOpenedAtLogin: true }));
    const launch = service('darwin', '/Applications/Timo.app/Contents/MacOS/Timo');

    expect(launch.shouldStartHidden()).toBe(true);
    expect(launch.launchOrigin()).toBe('LOGIN_ITEM');
    expect(launch.inspect().openedAtLogin).toBe(true);
  });

  it('requires the canonical approved Windows item, not only openAtLogin', () => {
    const exe = 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe';
    mocks.app.getLoginItemSettings.mockReturnValue(settings({
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
      launchItems: [item({ enabled: false })],
    }));

    expect(service('win32', exe).inspect()).toMatchObject({
      ready: false,
      state: 'NEEDS_REPAIR',
      remediation: 'ENABLE_STARTUP',
    });
  });

  it('accepts the current Windows path when Windows reports startup approval', () => {
    const exe = 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe';
    mocks.app.getLoginItemSettings.mockReturnValue(settings({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      launchItems: [item()],
    }));

    expect(service('win32', exe, ['Timo.exe', '--hidden']).inspect()).toMatchObject({
      ready: true,
      state: 'READY',
      openedAtLogin: true,
    });
  });

  it('trusts an enabled current Windows startup item even when Windows reports the display description name', () => {
    const exe = 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe';
    mocks.app.getLoginItemSettings.mockReturnValue(settings({
      openAtLogin: false,
      executableWillLaunchAtLogin: false,
      launchItems: [item({ name: 'Timo time tracker desktop agent', args: [] })],
    }));

    expect(service('win32', exe).inspect()).toMatchObject({
      ready: true,
      state: 'READY',
      remediation: 'NONE',
    });
  });

  it('repairs a disabled Windows item only after an explicit repair', () => {
    const exe = 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe';
    const disabled = settings({
      openAtLogin: true,
      executableWillLaunchAtLogin: false,
      launchItems: [item({ enabled: false })],
    });
    const ready = settings({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      launchItems: [item()],
    });
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(disabled)
      .mockReturnValueOnce(disabled)
      .mockReturnValueOnce(ready);

    const health = service('win32', exe).repair();

    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      enabled: true,
      name: 'Timo',
      path: exe,
      args: ['--hidden'],
    });
    expect(health).toMatchObject({ ready: true, state: 'READY' });
  });

  it('reports blocked when a Windows repair does not become effective', () => {
    const exe = 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe';
    const disabled = settings({ openAtLogin: true, launchItems: [item({ enabled: false })] });
    mocks.app.getLoginItemSettings.mockReturnValue(disabled);

    expect(service('win32', exe).repair()).toMatchObject({
      state: 'BLOCKED',
      remediation: 'OPEN_STARTUP_APPS',
      canRepair: false,
    });
  });

  it('removes legacy and wrong-path Windows entries during reconciliation', () => {
    const exe = 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe';
    const stale = settings({
      launchItems: [
        item({ name: 'Grind', path: 'C:\\Old\\Grind.exe' }),
        item({ name: 'Timo time tracker desktop agent', path: 'C:\\Old\\Timo\\Timo.exe' }),
        item({ path: 'C:\\Old\\Timo.exe' }),
        item({ name: 'Timo Legacy', path: 'C:\\Old\\Timo\\Timo.exe', args: [] }),
      ],
    });
    const ready = settings({ openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [item()] });
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(settings())
      .mockReturnValueOnce(ready);

    service('win32', exe).reconcileOnBoot();

    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({ openAtLogin: false, name: 'Grind' }));
    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({ openAtLogin: false, name: 'Timo time tracker desktop agent', path: 'C:\\Old\\Timo\\Timo.exe' }));
    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({ openAtLogin: false, name: 'Timo', path: 'C:\\Old\\Timo.exe' }));
    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({ openAtLogin: false, name: 'Timo Legacy', path: 'C:\\Old\\Timo\\Timo.exe' }));
  });

  it('keeps the canonical Windows startup item while removing duplicate Timo rows', () => {
    const exe = 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe';
    const duplicate = item({
      name: 'Timo time tracker desktop agent',
      path: 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo-old\\Timo.exe',
    });
    const ready = settings({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      launchItems: [item(), duplicate],
    });
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(ready)
      .mockReturnValueOnce(ready);

    service('win32', exe).repair();

    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith(expect.objectContaining({
      openAtLogin: false,
      name: 'Timo time tracker desktop agent',
      path: 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo-old\\Timo.exe',
    }));
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalledWith(expect.objectContaining({
      openAtLogin: false,
      name: 'Timo',
      path: exe,
      args: ['--hidden'],
    }));
  });

  it('does not remove the current Windows startup item when Windows reports the display description name', () => {
    const exe = 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe';
    const windowsDisplayItem = item({ name: 'Timo time tracker desktop agent', args: [] });
    const state = settings({
      openAtLogin: false,
      executableWillLaunchAtLogin: false,
      launchItems: [windowsDisplayItem],
    });
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(state)
      .mockReturnValueOnce(state);

    expect(service('win32', exe).repair()).toMatchObject({ ready: true, state: 'READY' });
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalledWith(expect.objectContaining({
      openAtLogin: false,
      name: 'Timo time tracker desktop agent',
      path: exe,
    }));
  });

  it('delegates a user-confirmed macOS move to Electron', () => {
    mocks.app.isInApplicationsFolder.mockReturnValue(false);
    mocks.app.getLoginItemSettings.mockReturnValue(settings());
    const conflictHandler = vi.fn(() => true);

    expect(service('darwin', '/Volumes/Timo/Timo.app/Contents/MacOS/Timo').moveToApplicationsFolder({ conflictHandler })).toBe(true);
    expect(mocks.app.moveToApplicationsFolder).toHaveBeenCalledWith({ conflictHandler });
  });
});
