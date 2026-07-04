import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginItemSettings } from 'electron';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: mocks.app,
}));

import { createLaunchAtLoginService } from './launchAtLogin';

function settings(patch: Partial<LoginItemSettings>): LoginItemSettings {
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

function service(platform: NodeJS.Platform, execPath: string) {
  return createLaunchAtLoginService({ app: mocks.app, platform, execPath });
}

describe('launch at login service', () => {
  beforeEach(() => {
    mocks.app.isPackaged = true;
    mocks.app.getLoginItemSettings.mockReset();
    mocks.app.setLoginItemSettings.mockReset();
  });

  it('does not register login items in dev mode', () => {
    mocks.app.isPackaged = false;

    const info = service('darwin', '/Applications/Timo.app/Contents/MacOS/Timo').enable();

    expect(info).toEqual({
      enabled: false,
      status: 'unavailable-dev',
      canRegister: false,
      reason: null,
    });
    expect(mocks.app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('blocks macOS registration when running from a mounted DMG', () => {
    const info = service('darwin', '/Volumes/Timo 0.0.2/Timo.app/Contents/MacOS/Timo').enable();

    expect(info).toEqual({
      enabled: false,
      status: 'blocked-dmg',
      canRegister: false,
      reason: 'running-from-dmg',
    });
    expect(mocks.app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('registers a packaged macOS app from a stable installed path', () => {
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(settings({ openAtLogin: false, status: 'not-registered' }))
      .mockReturnValueOnce(settings({ openAtLogin: true, status: 'enabled' }));

    const info = service('darwin', '/Applications/Timo.app/Contents/MacOS/Timo').enable();

    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    expect(info).toMatchObject({ enabled: true, status: 'enabled', canRegister: false });
  });

  it('surfaces macOS approval-required state without treating it as enabled', () => {
    mocks.app.getLoginItemSettings.mockReturnValue(settings({ openAtLogin: true, status: 'requires-approval' }));

    const info = service('darwin', '/Applications/Timo.app/Contents/MacOS/Timo').enable();

    expect(info).toEqual({
      enabled: false,
      status: 'requires-approval',
      canRegister: false,
      reason: null,
    });
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('registers Windows with the executable path and hidden argument', () => {
    const exe = 'C:\\Users\\Anish\\AppData\\Local\\Programs\\Timo\\Timo.exe';
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(settings({ openAtLogin: false }))
      .mockReturnValueOnce(settings({ openAtLogin: true, executableWillLaunchAtLogin: true }));

    const info = service('win32', exe).enable();

    expect(mocks.app.getLoginItemSettings).toHaveBeenCalledWith({ path: exe, args: ['--hidden'] });
    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: exe,
      args: ['--hidden'],
    });
    expect(info).toMatchObject({ enabled: true, status: 'enabled', canRegister: false });
  });
});
