import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdateMemory } from './memory';

type Listener = (...args: unknown[]) => void;
type MockTimerStatus = { state: 'IDLE' } | { state: 'RUNNING'; paused: boolean };

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Listener[]>();
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    channelValue: '',
    // Mirrors electron-updater's AppUpdater: setting the channel flips
    // allowDowngrade on, every time.
    get channel(): string {
      return autoUpdater.channelValue;
    },
    set channel(value: string) {
      autoUpdater.channelValue = value;
      autoUpdater.allowDowngrade = true;
    },
    logger: null as unknown,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return autoUpdater;
    }),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  };

  return {
    appIsPackaged: true,
    appVersion: '0.0.2-beta.22',
    autoUpdateEnabled: true,
    timerStatus: { state: 'IDLE' } as MockTimerStatus,
    listeners,
    autoUpdater,
    broadcast: vi.fn(),
    drainUploads: vi.fn(),
    runQuitCleanup: vi.fn(),
    invalidateQuitCleanup: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    logDebug: vi.fn(),
    showMessageBox: vi.fn(),
    openExternal: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.appIsPackaged;
    },
    getVersion: () => mocks.appVersion,
    getPath: () => os.tmpdir(),
    quit: vi.fn(),
  },
  dialog: {
    showMessageBox: mocks.showMessageBox,
  },
  shell: {
    openExternal: mocks.openExternal,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  Notification: Object.assign(
    vi.fn(() => ({
      on: vi.fn(),
      show: vi.fn(),
    })),
    { isSupported: () => false },
  ),
}));

vi.mock('electron-updater', () => ({
  autoUpdater: mocks.autoUpdater,
}));

vi.mock('../../env', () => ({
  API_URL: 'https://timo.example.com/',
  AUTO_UPDATE_ENABLED: mocks.autoUpdateEnabled,
  UPDATE_CHANNEL: 'beta',
}));

vi.mock('../../broadcast', () => ({
  broadcast: mocks.broadcast,
}));

vi.mock('../../logger', () => ({
  log: {
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    debug: mocks.logDebug,
  },
}));

vi.mock('../capture/uploader', () => ({
  drainUploads: mocks.drainUploads,
}));

vi.mock('../quitCleanup', () => ({
  runQuitCleanup: mocks.runQuitCleanup,
  invalidateQuitCleanup: mocks.invalidateQuitCleanup,
}));

vi.mock('../timer', () => ({
  getTimerService: () => ({
    status: () => mocks.timerStatus,
  }),
}));

function emitUpdater(event: string, ...args: unknown[]): void {
  for (const listener of mocks.listeners.get(event) ?? []) listener(...args);
}

const WINDOWS_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\asha\\AppData\\Local',
};
const MACHINE_EXE = 'C:\\Program Files\\Grind\\Timo\\Timo.exe';
const USER_EXE = 'C:\\Users\\asha\\AppData\\Local\\Programs\\Timo\\Timo.exe';

let memoryDir: string;

describe('update service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.appIsPackaged = true;
    mocks.appVersion = '0.0.2-beta.22';
    mocks.autoUpdateEnabled = true;
    mocks.timerStatus = { state: 'IDLE' };
    mocks.listeners.clear();
    mocks.autoUpdater.autoDownload = false;
    mocks.autoUpdater.autoInstallOnAppQuit = false;
    mocks.autoUpdater.allowPrerelease = false;
    mocks.autoUpdater.channelValue = '';
    mocks.autoUpdater.allowDowngrade = false;
    mocks.autoUpdater.logger = null;
    mocks.autoUpdater.on.mockClear();
    mocks.autoUpdater.checkForUpdates.mockReset().mockResolvedValue(undefined);
    mocks.autoUpdater.quitAndInstall.mockReset();
    mocks.broadcast.mockReset();
    mocks.drainUploads.mockReset().mockResolvedValue(undefined);
    mocks.runQuitCleanup.mockReset().mockResolvedValue(undefined);
    mocks.invalidateQuitCleanup.mockReset();
    mocks.logInfo.mockReset();
    mocks.logWarn.mockReset();
    mocks.logError.mockReset();
    mocks.logDebug.mockReset();
    mocks.showMessageBox.mockReset().mockResolvedValue({ response: 1 });
    mocks.openExternal.mockReset().mockResolvedValue(undefined);
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'timo-updates-'));
  });

  afterEach(async () => {
    const updates = await import('./index');
    updates.stopUpdateServiceForTests();
    vi.useRealTimers();
    vi.resetModules();
    fs.rmSync(memoryDir, { recursive: true, force: true });
  });

  function memory() {
    return createUpdateMemory(path.join(memoryDir, 'update-state.json'));
  }

  it('enables electron-updater only for packaged update-enabled builds', async () => {
    const { startUpdateService } = await import('./index');

    const status = startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });

    expect(status).toMatchObject({
      enabled: true,
      currentVersion: '0.0.2-beta.22',
      channel: 'beta',
      phase: 'idle',
    });
    expect(mocks.autoUpdater.autoDownload).toBe(true);
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(mocks.autoUpdater.allowPrerelease).toBe(true);
    expect(mocks.autoUpdater.channel).toBe('beta');
    // The channel setter turned downgrades on; the service must turn them back
    // off, or a build newer than the newest PUBLISHED release rolls back.
    expect(mocks.autoUpdater.allowDowngrade).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('stays disabled when the app is not packaged', async () => {
    mocks.appIsPackaged = false;
    const { startUpdateService } = await import('./index');

    const status = startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });

    expect(status.enabled).toBe(false);
    expect(mocks.autoUpdater.on).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('downloads an update but blocks install while tracking is running', async () => {
    mocks.timerStatus = { state: 'RUNNING', paused: false };
    const { getUpdateStatus, installUpdateNow, startUpdateService } = await import('./index');
    startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });

    emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });

    expect(getUpdateStatus()).toMatchObject({
      phase: 'ready',
      availableVersion: '0.0.2-beta.24',
      canInstallNow: false,
    });

    await installUpdateNow();

    expect(mocks.runQuitCleanup).not.toHaveBeenCalled();
    expect(mocks.drainUploads).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('flushes local work before installing once tracking has stopped', async () => {
    mocks.timerStatus = { state: 'RUNNING', paused: false };
    const { getUpdateStatus, installUpdateNow, startUpdateService } = await import('./index');
    startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });
    emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });

    mocks.timerStatus = { state: 'IDLE' };
    const status = await installUpdateNow();

    expect(status).toMatchObject({
      phase: 'installing',
      availableVersion: '0.0.2-beta.24',
      canInstallNow: true,
    });
    expect(getUpdateStatus().phase).toBe('installing');
    expect(mocks.runQuitCleanup).toHaveBeenCalledWith('update');
    expect(mocks.drainUploads).toHaveBeenCalledOnce();
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('lets a ready update take over a permission restart', async () => {
    const { installUpdateInsteadOfRelaunch, startUpdateService } = await import('./index');
    startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });
    emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });

    await expect(installUpdateInsteadOfRelaunch()).resolves.toBe(true);
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('switches install-on-quit off for a plain permission restart', async () => {
    const { installUpdateInsteadOfRelaunch, startUpdateService } = await import('./index');
    startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });
    // Still downloading: nothing is installable, but nothing may start
    // installing underneath the relaunch either.
    emitUpdater('update-available', { version: '0.0.2-beta.24' });

    await expect(installUpdateInsteadOfRelaunch()).resolves.toBe(false);
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('invalidates the early quit cleanup when the install then fails', async () => {
    const { getUpdateStatus, installUpdateNow, startUpdateService } = await import('./index');
    startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });
    emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });
    await installUpdateNow();
    expect(mocks.runQuitCleanup).toHaveBeenCalledWith('update');

    emitUpdater('error', new Error('installer could not start'));

    // The app keeps running; the next Quit has to finalize the timer again.
    expect(mocks.invalidateQuitCleanup).toHaveBeenCalledOnce();
    expect(getUpdateStatus().phase).toBe('error');
  });

  it('does not invalidate anything for an ordinary failed check', async () => {
    const { startUpdateService } = await import('./index');
    startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });

    emitUpdater('error', new Error('offline'));

    expect(mocks.invalidateQuitCleanup).not.toHaveBeenCalled();
  });

  describe('Windows install scope', () => {
    it('never starts electron-updater for a Program Files install and says why', async () => {
      const { getUpdateDiagnostics, getUpdateStatus, startUpdateService } = await import('./index');

      const status = startUpdateService({
        showMainWindow: vi.fn(),
        platform: 'win32',
        execPath: MACHINE_EXE,
        env: WINDOWS_ENV,
        memory: memory(),
      });

      expect(status).toMatchObject({ enabled: false, installScope: 'machine', blockedReason: 'machine-install' });
      expect(mocks.autoUpdater.on).not.toHaveBeenCalled();
      expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
      expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(getUpdateStatus().blockedReason).toBe('machine-install');
      expect(getUpdateDiagnostics()).toEqual({
        installScope: 'machine',
        updateError: expect.stringContaining('UPDATES_BLOCKED_MACHINE_INSTALL'),
      });
      expect(mocks.logWarn).toHaveBeenCalledWith(
        'updates blocked: per-machine install cannot update itself',
        expect.objectContaining({ installScope: 'machine' }),
      );
    });

    it('shows the download notice once and opens the installer download', async () => {
      mocks.showMessageBox.mockResolvedValue({ response: 0 });
      const first = await import('./index');
      first.startUpdateService({
        showMainWindow: vi.fn(),
        platform: 'win32',
        execPath: MACHINE_EXE,
        env: WINDOWS_ENV,
        memory: memory(),
      });
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(mocks.showMessageBox).toHaveBeenCalledOnce();
      expect(mocks.showMessageBox.mock.calls[0]![0]).toMatchObject({
        message: 'Timo can’t update itself here — download the new installer',
        buttons: ['Download installer', 'Later'],
      });
      expect(mocks.openExternal).toHaveBeenCalledWith('https://timo.example.com/v1/downloads/agent/windows');

      // Next launch of the same install: no second notice.
      first.stopUpdateServiceForTests();
      vi.resetModules();
      const second = await import('./index');
      second.startUpdateService({
        showMainWindow: vi.fn(),
        platform: 'win32',
        execPath: MACHINE_EXE,
        env: WINDOWS_ENV,
        memory: memory(),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.showMessageBox).toHaveBeenCalledOnce();
    });

    it('does not open anything when the notice is dismissed', async () => {
      const { startUpdateService } = await import('./index');
      startUpdateService({
        showMainWindow: vi.fn(),
        platform: 'win32',
        execPath: MACHINE_EXE,
        env: WINDOWS_ENV,
        memory: memory(),
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocks.showMessageBox).toHaveBeenCalledOnce();
      expect(mocks.openExternal).not.toHaveBeenCalled();
    });

    it('updates a per-user install normally and reports its scope', async () => {
      const { getUpdateDiagnostics, startUpdateService } = await import('./index');
      const status = startUpdateService({
        showMainWindow: vi.fn(),
        platform: 'win32',
        execPath: USER_EXE,
        env: WINDOWS_ENV,
        memory: memory(),
      });
      expect(status).toMatchObject({ enabled: true, installScope: 'user', blockedReason: null });
      expect(getUpdateDiagnostics()).toEqual({ installScope: 'user', updateError: null });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
    });
  });

  describe('update errors', () => {
    it('counts a failed check once, logs its code, and reports it', async () => {
      const failure = Object.assign(new Error('Cannot find beta.yml in the latest release artifacts'), {
        code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
      });
      // electron-updater emits 'error' AND rejects checkForUpdates() with the same object.
      mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
        emitUpdater('error', failure);
        throw failure;
      });
      const { getUpdateDiagnostics, startUpdateService } = await import('./index');
      startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });

      await vi.advanceTimersByTimeAsync(5_000);

      const failures = mocks.logWarn.mock.calls.filter(([msg]) => msg === 'update failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]![1]).toMatchObject({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', manual: false });
      expect(getUpdateDiagnostics().updateError).toBe(
        'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND: Cannot find beta.yml in the latest release artifacts',
      );
      // One failure → the first (15-minute) retry, not the second.
      expect(mocks.logInfo).toHaveBeenCalledWith('update auto retry scheduled', {
        delayMs: 15 * 60_000,
        automaticErrorCount: 1,
      });
    });

    it('clears the reported error once a check succeeds', async () => {
      const { getUpdateDiagnostics, startUpdateService } = await import('./index');
      startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });

      emitUpdater('error', Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }));
      expect(getUpdateDiagnostics().updateError).toBe('ETIMEDOUT: connect timed out');

      emitUpdater('update-not-available', { version: '0.0.2-beta.22' });
      expect(getUpdateDiagnostics().updateError).toBeNull();
    });

    it('reports a failed install with its code', async () => {
      const { getUpdateDiagnostics, installUpdateNow, startUpdateService } = await import('./index');
      startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });
      emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });
      await installUpdateNow();

      emitUpdater('error', Object.assign(new Error('installer could not start'), { code: 'EACCES' }));

      expect(getUpdateDiagnostics().updateError).toBe('EACCES: installer could not start');
      expect(mocks.logWarn).toHaveBeenCalledWith('update failed', expect.objectContaining({ code: 'EACCES', installing: true }));
    });

    it('does not leave the background download rejection unhandled', async () => {
      mocks.autoUpdater.checkForUpdates.mockImplementation(async () => ({
        downloadPromise: Promise.reject(new Error('download failed')),
      }));
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const { checkForUpdates, startUpdateService } = await import('./index');
        startUpdateService({ showMainWindow: vi.fn(), isMainWindowVisible: () => false });
        await checkForUpdates(true);
        vi.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });

  describe('Windows session end and launch install', () => {
    it('holds install-on-quit when the Windows session ends', async () => {
      const { holdUpdateInstallForSessionEnd, startUpdateService } = await import('./index');
      startUpdateService({ showMainWindow: vi.fn(), platform: 'win32', execPath: USER_EXE, env: WINDOWS_ENV, memory: memory() });
      emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });
      expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);

      holdUpdateInstallForSessionEnd();

      expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
    });

    it('is a no-op when updates are off', async () => {
      mocks.appIsPackaged = false;
      const { holdUpdateInstallForSessionEnd, startUpdateService } = await import('./index');
      startUpdateService({ showMainWindow: vi.fn() });
      mocks.autoUpdater.autoInstallOnAppQuit = true;
      holdUpdateInstallForSessionEnd();
      expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    });

    it('installs an update staged by an earlier session right after launch, once per version', async () => {
      const first = await import('./index');
      first.startUpdateService({ showMainWindow: vi.fn(), platform: 'win32', execPath: USER_EXE, env: WINDOWS_ENV, memory: memory() });
      await vi.advanceTimersByTimeAsync(5_000);

      emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.runQuitCleanup).toHaveBeenCalledWith('update');
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
      expect(mocks.logInfo).toHaveBeenCalledWith('installing staged update at launch', expect.objectContaining({ version: '0.0.2-beta.24' }));

      // The install did not take (same version came back up): no second try.
      first.stopUpdateServiceForTests();
      vi.resetModules();
      mocks.listeners.clear();
      mocks.autoUpdater.quitAndInstall.mockReset();
      const second = await import('./index');
      second.startUpdateService({ showMainWindow: vi.fn(), platform: 'win32', execPath: USER_EXE, env: WINDOWS_ENV, memory: memory() });
      emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
      expect(second.getUpdateStatus().phase).toBe('ready');
    });

    it('leaves an update that arrives later in the day for the person to restart', async () => {
      const { getUpdateStatus, startUpdateService } = await import('./index');
      startUpdateService({ showMainWindow: vi.fn(), platform: 'win32', execPath: USER_EXE, env: WINDOWS_ENV, memory: memory() });
      await vi.advanceTimersByTimeAsync(4 * 60_000);

      emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
      expect(getUpdateStatus().phase).toBe('ready');
    });

    it('never installs at launch while a timer is running', async () => {
      mocks.timerStatus = { state: 'RUNNING', paused: false };
      const { startUpdateService } = await import('./index');
      startUpdateService({ showMainWindow: vi.fn(), platform: 'win32', execPath: USER_EXE, env: WINDOWS_ENV, memory: memory() });
      emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('keeps the launch install to Windows', async () => {
      const { startUpdateService } = await import('./index');
      startUpdateService({ showMainWindow: vi.fn(), platform: 'darwin', memory: memory() });
      emitUpdater('update-downloaded', { version: '0.0.2-beta.24' });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });
  });
});
