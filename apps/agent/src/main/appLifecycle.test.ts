import { describe, expect, it, vi } from 'vitest';
import type { BeforeQuitEventLike } from './appLifecycle';

vi.mock('electron', () => ({ app: {} }));
vi.mock('./services/activity', () => ({ stopActivityCapture: vi.fn() }));
vi.mock('./services/quitCleanup', () => ({
  runQuitCleanup: vi.fn(),
  hasQuitCleanupCompleted: vi.fn(),
  invalidateQuitCleanup: vi.fn(),
}));
vi.mock('./services/timer', () => ({ getTimerService: vi.fn() }));
vi.mock('./logger', () => ({ log: { info: vi.fn(), warn: vi.fn() }, flushLogs: vi.fn() }));

const { createAppLifecycle } = await import('./appLifecycle');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function harness(opts: {
  platform?: NodeJS.Platform;
  cleanupCompleted?: boolean;
  timerRunning?: boolean;
  runCleanup?: (reason: string) => Promise<void>;
} = {}) {
  const listeners = new Map<string, (event?: BeforeQuitEventLike) => void>();
  const state = { cleanupCompleted: opts.cleanupCompleted ?? false, timerRunning: opts.timerRunning ?? false };
  const app = {
    on: vi.fn((event: string, listener: (event?: BeforeQuitEventLike) => void) => {
      listeners.set(event, listener);
    }),
    quit: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
  };
  const updater = { autoInstallOnAppQuit: false, quitAndInstall: vi.fn() };
  const deps = {
    app,
    platform: opts.platform ?? 'darwin',
    runCleanup: vi.fn(opts.runCleanup ?? (async () => undefined)),
    hasCleanupCompleted: () => state.cleanupCompleted,
    invalidateCleanup: vi.fn(),
    isTimerRunning: () => state.timerRunning,
    stopActivityCapture: vi.fn(),
    flushLogs: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const lifecycle = createAppLifecycle(deps);
  const fire = (event: string, preventDefault = vi.fn()) => {
    listeners.get(event)!({ preventDefault });
    return preventDefault;
  };
  return { lifecycle, app, updater, deps, state, fire };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('app lifecycle: quitting', () => {
  it('holds the quit until the cleanup finishes, then quits again', async () => {
    const cleanup = deferred();
    const { lifecycle, app, deps, fire } = harness({ runCleanup: () => cleanup.promise });
    lifecycle.registerQuitHandlers();

    const preventDefault = fire('before-quit');

    expect(lifecycle.isQuitting()).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(deps.runCleanup).toHaveBeenCalledWith('quit');
    expect(app.quit).not.toHaveBeenCalled();
    cleanup.resolve();
    await settle();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('lets the quit through, stopping the input hook, once a cleanup already covers it', () => {
    const { lifecycle, deps, fire } = harness({ cleanupCompleted: true });
    lifecycle.registerQuitHandlers();

    const preventDefault = fire('before-quit');

    expect(preventDefault).not.toHaveBeenCalled();
    expect(deps.runCleanup).not.toHaveBeenCalled();
    expect(deps.stopActivityCapture).toHaveBeenCalledOnce();
  });

  it('stops the input hook on the re-issued quit, not while the cleanup can still be cancelled', async () => {
    const { lifecycle, app, deps, fire } = harness();
    app.quit.mockImplementation(() => fire('before-quit'));
    lifecycle.registerQuitHandlers();

    fire('before-quit');
    expect(deps.stopActivityCapture).not.toHaveBeenCalled();
    await settle();

    expect(app.quit).toHaveBeenCalledOnce();
    expect(deps.stopActivityCapture).toHaveBeenCalledOnce();
  });

  it('runs the cleanup again when a timer was started after an earlier cleanup', async () => {
    const { lifecycle, deps, state, fire } = harness({ cleanupCompleted: true, timerRunning: true });
    deps.runCleanup.mockImplementation(async () => {
      state.timerRunning = false;
    });
    lifecycle.registerQuitHandlers();

    const preventDefault = fire('before-quit');

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(deps.runCleanup).toHaveBeenCalledWith('quit');
  });

  it('does not loop when the cleanup could not stop the timer', async () => {
    const { lifecycle, app, deps, fire } = harness({ cleanupCompleted: true, timerRunning: true });
    app.quit.mockImplementation(() => fire('before-quit'));
    lifecycle.registerQuitHandlers();

    fire('before-quit');
    await settle();

    expect(deps.runCleanup).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('finalizes on the update exit path only when the earlier cleanup no longer holds', () => {
    const { lifecycle, deps, state, fire } = harness({ cleanupCompleted: true });
    lifecycle.registerQuitHandlers();

    fire('before-quit-for-update');
    expect(lifecycle.isQuitting()).toBe(true);
    expect(deps.runCleanup).not.toHaveBeenCalled();

    state.timerRunning = true;
    fire('before-quit-for-update');
    expect(deps.runCleanup).toHaveBeenCalledWith('update');
  });

  it('registers its handlers once', () => {
    const { lifecycle, app } = harness();
    lifecycle.registerQuitHandlers();
    lifecycle.registerQuitHandlers();
    expect(app.on).toHaveBeenCalledTimes(2);
  });

  it('quit() asks Electron to quit and leaves the cleanup to before-quit', () => {
    const { lifecycle, app, deps } = harness();
    lifecycle.quit('tray');
    expect(app.quit).toHaveBeenCalledOnce();
    expect(deps.runCleanup).not.toHaveBeenCalled();
  });
});

describe('app lifecycle: relaunch', () => {
  it('finalizes, switches install-on-quit off, then relaunches', async () => {
    const { lifecycle, app, updater, deps } = harness();
    lifecycle.attachUpdater({ updater, installReadyUpdate: async () => false });
    expect(updater.autoInstallOnAppQuit).toBe(true);

    await lifecycle.relaunch('permission');

    expect(deps.runCleanup).toHaveBeenCalledWith('quit');
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(deps.stopActivityCapture).toHaveBeenCalledOnce();
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(lifecycle.isQuitting()).toBe(true);
    expect(deps.runCleanup.mock.invocationCallOrder[0]).toBeLessThan(app.relaunch.mock.invocationCallOrder[0]!);
  });

  it('hands the restart to a ready update instead', async () => {
    const { lifecycle, app, updater } = harness();
    lifecycle.attachUpdater({ updater, installReadyUpdate: async () => true });

    await lifecycle.relaunch('permission');

    expect(app.relaunch).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
  });

  it('relaunches without an updater (dev or machine install)', async () => {
    const { lifecycle, app } = harness();
    await lifecycle.relaunch('permission');
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(0);
  });

  it('shares one relaunch between double clicks', async () => {
    const { lifecycle, app } = harness();
    await Promise.all([lifecycle.relaunch('permission'), lifecycle.relaunch('permission')]);
    expect(app.relaunch).toHaveBeenCalledOnce();
  });
});

describe('app lifecycle: update install', () => {
  it('owns electron-updater\'s install-on-quit flag', () => {
    const { lifecycle, updater } = harness();
    lifecycle.holdUpdateInstallOnQuit('before-attach');
    expect(updater.autoInstallOnAppQuit).toBe(false);

    lifecycle.attachUpdater({ updater, installReadyUpdate: async () => false });
    expect(updater.autoInstallOnAppQuit).toBe(true);
    lifecycle.holdUpdateInstallOnQuit('test');
    expect(updater.autoInstallOnAppQuit).toBe(false);
    lifecycle.allowUpdateInstallOnQuit('test');
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it('asks electron-updater to install and relaunch, switching install-on-quit off on macOS', () => {
    const { lifecycle, updater } = harness({ platform: 'darwin' });
    lifecycle.attachUpdater({ updater, installReadyUpdate: async () => false });

    lifecycle.installUpdate('manual', { silent: false });

    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('leaves install-on-quit alone on Windows', () => {
    const { lifecycle, updater } = harness({ platform: 'win32' });
    lifecycle.attachUpdater({ updater, installReadyUpdate: async () => false });

    lifecycle.installUpdate('launch', { silent: true });

    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('refuses to install without an updater', () => {
    const { lifecycle } = harness();
    expect(() => lifecycle.installUpdate('manual', { silent: false })).toThrow();
  });

  it('falls back to quitting with install-on-quit on, relaunching first', () => {
    const { lifecycle, app, updater } = harness();
    lifecycle.attachUpdater({ updater, installReadyUpdate: async () => false });
    updater.autoInstallOnAppQuit = false;

    lifecycle.quitToInstallUpdate('manual');

    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.relaunch.mock.invocationCallOrder[0]).toBeLessThan(app.quit.mock.invocationCallOrder[0]!);
  });

  it('prepares and abandons an exit someone else performs', async () => {
    const { lifecycle, deps } = harness();
    await lifecycle.prepareExit('update');
    expect(deps.runCleanup).toHaveBeenCalledWith('update');
    lifecycle.abortExit('install-failed');
    expect(deps.invalidateCleanup).toHaveBeenCalledOnce();
  });
});

describe('app lifecycle: Windows session end', () => {
  it('holds install-on-quit for good and finalizes tracked time', async () => {
    const { lifecycle, updater, deps } = harness({ platform: 'win32' });
    lifecycle.attachUpdater({ updater, installReadyUpdate: async () => false });

    await lifecycle.endSession('windows-session-end');

    expect(lifecycle.isQuitting()).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(deps.runCleanup).toHaveBeenCalledWith('shutdown');
    // Nothing later in this process may start an installer.
    lifecycle.allowUpdateInstallOnQuit('install-aborted');
    lifecycle.quitToInstallUpdate('manual');
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('skips the cleanup when an earlier one still holds', async () => {
    const { lifecycle, deps } = harness({ cleanupCompleted: true });
    await lifecycle.endSession('windows-session-end');
    expect(deps.runCleanup).not.toHaveBeenCalled();
  });
});

describe('app lifecycle: failed boot', () => {
  it('exits without a cleanup so the single-instance lock is released', async () => {
    const { lifecycle, app, deps } = harness();
    await lifecycle.exitAfterFailedBoot('no-ui');
    expect(deps.runCleanup).not.toHaveBeenCalled();
    expect(deps.flushLogs).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(1);
    expect(lifecycle.isQuitting()).toBe(true);
  });
});
