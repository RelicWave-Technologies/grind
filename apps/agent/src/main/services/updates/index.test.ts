import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;
type MockTimerStatus = { state: 'IDLE' } | { state: 'RUNNING'; paused: boolean };

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Listener[]>();
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    channel: '',
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
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    logDebug: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.appIsPackaged;
    },
    getVersion: () => mocks.appVersion,
    quit: vi.fn(),
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
}));

vi.mock('../timer', () => ({
  getTimerService: () => ({
    status: () => mocks.timerStatus,
  }),
}));

function emitUpdater(event: string, ...args: unknown[]): void {
  for (const listener of mocks.listeners.get(event) ?? []) listener(...args);
}

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
    mocks.autoUpdater.channel = '';
    mocks.autoUpdater.logger = null;
    mocks.autoUpdater.on.mockClear();
    mocks.autoUpdater.checkForUpdates.mockReset().mockResolvedValue(undefined);
    mocks.autoUpdater.quitAndInstall.mockReset();
    mocks.broadcast.mockReset();
    mocks.drainUploads.mockReset().mockResolvedValue(undefined);
    mocks.runQuitCleanup.mockReset().mockResolvedValue(undefined);
    mocks.logInfo.mockReset();
    mocks.logWarn.mockReset();
    mocks.logError.mockReset();
    mocks.logDebug.mockReset();
  });

  afterEach(async () => {
    const updates = await import('./index');
    updates.stopUpdateServiceForTests();
    vi.useRealTimers();
    vi.resetModules();
  });

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
});
