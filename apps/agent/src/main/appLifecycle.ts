import { app } from 'electron';
import { stopActivityCapture } from './services/activity';
import { hasQuitCleanupCompleted, invalidateQuitCleanup, runQuitCleanup } from './services/quitCleanup';
import { getTimerService } from './services/timer';
import type { TimerExitReason } from './services/timer/types';
import { flushLogs, log } from './logger';

/**
 * The one place that ends (or restarts) Timo.
 *
 * Quitting used to be spread over the tray, power events, the Windows session
 * hook, the permission restart, Move to Applications and the updater — each
 * with its own copy of "set isQuitting, run the cleanup, poke the updater's
 * install-on-quit flag", and they disagreed. Every exit now goes through here:
 *
 *  - quit(reason)            an ordinary quit; before-quit runs the cleanup.
 *  - relaunch(reason)        cleanup, then a ready update takes the restart over
 *                            or the app relaunches itself.
 *  - installUpdate(reason)   hand the exit to electron-updater's quitAndInstall.
 *  - quitToInstallUpdate()   last resort when quitAndInstall did not quit: quit
 *                            with install-on-quit on, and come back up after.
 *  - endSession(reason)      Windows is ending the session: finalize, never
 *                            start an installer.
 *
 * It also owns the `isQuitting` flag, the input-hook stop on the way out, and
 * electron-updater's `autoInstallOnAppQuit`.
 */

export type QuitReason = 'tray' | 'menu' | 'system-shutdown' | 'update-fallback';
export type RelaunchReason = 'permission';

export interface BeforeQuitEventLike {
  preventDefault(): void;
}

export interface LifecycleApp {
  quit(): void;
  exit(code?: number): void;
  relaunch(): void;
  on(event: 'before-quit', listener: (event: BeforeQuitEventLike) => void): unknown;
  on(event: 'before-quit-for-update', listener: () => void): unknown;
}

/** The slice of electron-updater's autoUpdater that exiting needs. */
export interface LifecycleUpdater {
  autoInstallOnAppQuit: boolean;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AttachedUpdater {
  updater: LifecycleUpdater;
  /** Install a ready update now; true when the install owns the exit. */
  installReadyUpdate(): Promise<boolean>;
}

export interface AppLifecycleDeps {
  app: LifecycleApp;
  platform: NodeJS.Platform;
  runCleanup(reason: TimerExitReason): Promise<void>;
  hasCleanupCompleted(): boolean;
  invalidateCleanup(): void;
  isTimerRunning(): boolean;
  /** Stops the global input hook; a native hook left running can crash the exit. */
  stopActivityCapture?(): void;
  flushLogs?(): Promise<unknown> | unknown;
  log: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
}

export function createAppLifecycle(deps: AppLifecycleDeps) {
  let quitting = false;
  let handlersRegistered = false;
  let attached: AttachedUpdater | null = null;
  /** Windows is ending the session; nothing may turn install-on-quit back on. */
  let sessionEnding = false;
  let inputHookStopped = false;
  let relaunching: Promise<void> | null = null;

  function stopInputHook(): void {
    if (inputHookStopped) return;
    inputHookStopped = true;
    try {
      deps.stopActivityCapture?.();
    } catch (err) {
      deps.log.warn('input hook stop on exit failed', { err: String(err) });
    }
  }

  /**
   * A finished cleanup only vouches for the timer as it was when it ran. The
   * update install runs it early and then waits for the installer to quit the
   * app; if the install fails, or the person starts tracking again meanwhile, a
   * "completed" flag would let the next Quit skip finalizing a running timer.
   */
  function cleanupStillCovers(): boolean {
    return deps.hasCleanupCompleted() && !deps.isTimerRunning();
  }

  /**
   * Run the cleanup unless one already finished and still holds. For exit
   * paths that cannot wait (before-quit-for-update, Windows session end): the
   * timer close is written synchronously before the first await, so starting
   * it is what matters. Shares the in-flight run, so no path runs it twice.
   */
  function cleanupIfNeeded(reason: TimerExitReason): Promise<void> {
    return cleanupStillCovers() ? Promise.resolve() : deps.runCleanup(reason);
  }

  function setInstallOnQuit(on: boolean, reason: string): void {
    if (!attached) return;
    if (on && sessionEnding) return;
    if (attached.updater.autoInstallOnAppQuit === on) return;
    attached.updater.autoInstallOnAppQuit = on;
    deps.log.info('update install-on-quit changed', { on, reason });
  }

  function registerQuitHandlers(): void {
    if (handlersRegistered) return;
    handlersRegistered = true;
    // The quit we re-issue after our own cleanup always goes through, even if
    // that cleanup could not stop the timer — otherwise Quit would loop.
    let reissuing = false;
    deps.app.on('before-quit', (event) => {
      quitting = true;
      if (reissuing || cleanupStillCovers()) {
        stopInputHook();
        return;
      }
      event.preventDefault();
      void deps.runCleanup('quit').finally(() => {
        reissuing = true;
        try {
          deps.app.quit();
        } finally {
          reissuing = false;
        }
      });
    });
    deps.app.on('before-quit-for-update', () => {
      quitting = true;
      // installUpdate's caller already ran the cleanup; only run it again if
      // it no longer holds (a timer was started while the install got ready).
      void cleanupIfNeeded('update');
    });
  }

  function quit(reason: QuitReason): void {
    deps.log.info('quit requested', { reason });
    deps.app.quit();
  }

  /**
   * Restart Timo in place (the permission fallback). The cleanup runs first
   * because app.exit() skips before-quit. A ready update takes the restart
   * over (quitAndInstall relaunches on its own); otherwise install-on-quit is
   * switched off for this exit — a staged update installing underneath the
   * relaunch races the old binary coming back up. The next launch turns it on.
   */
  function relaunch(reason: RelaunchReason): Promise<void> {
    if (relaunching) return relaunching;
    relaunching = (async () => {
      deps.log.info('relaunch requested', { reason });
      await deps.runCleanup('quit');
      if (attached && (await attached.installReadyUpdate())) {
        deps.log.info('relaunch handed to the update install', { reason });
        return;
      }
      setInstallOnQuit(false, `relaunch:${reason}`);
      quitting = true;
      stopInputHook();
      await Promise.resolve(deps.flushLogs?.()).catch(() => undefined);
      deps.app.relaunch();
      deps.app.exit(0);
    })().finally(() => {
      relaunching = null;
    });
    return relaunching;
  }

  /** Hand the exit to electron-updater. Throws what quitAndInstall throws. */
  function installUpdate(reason: string, opts: { silent: boolean }): void {
    if (!attached) throw new Error('update install requested with no updater attached');
    if (deps.platform === 'darwin') {
      // On macOS the native updater can still be staging when electron-updater
      // emits "update-downloaded". Switching this off before a manual install
      // makes MacUpdater ask the native updater to finish preparing instead of
      // waiting quietly for a later app quit.
      setInstallOnQuit(false, `install:${reason}`);
    }
    deps.log.info('update install handed to electron-updater', { reason, silent: opts.silent });
    // isForceRunAfter: Timo comes back up after the installer finishes.
    attached.updater.quitAndInstall(opts.silent, true);
  }

  /**
   * quitAndInstall did not quit the app. Quit with install-on-quit on, and
   * relaunch: install-on-quit itself never starts the app again, which is how
   * a stuck install used to read as "Timo closed by itself".
   */
  function quitToInstallUpdate(reason: string): void {
    setInstallOnQuit(true, `fallback:${reason}`);
    deps.log.warn('quitting to install update with relaunch', { reason });
    deps.app.relaunch();
    quit('update-fallback');
  }

  /**
   * Windows is ending the session (shutdown, restart, sign-off). An installer
   * started now would be killed part-way, so install-on-quit is switched off
   * for the rest of this process; the staged update stays cached and the next
   * launch installs it. Then finalize tracked time.
   */
  function endSession(reason: string): Promise<void> {
    quitting = true;
    if (!sessionEnding) {
      setInstallOnQuit(false, `session-end:${reason}`);
      sessionEnding = true;
      deps.log.info('session ending; finalizing tracked time', { reason });
    }
    return cleanupIfNeeded('shutdown');
  }

  /**
   * Boot could not build any UI. Exit so the single-instance lock is released
   * and the next launch starts clean — an invisible Timo holding the lock made
   * every later launch a no-op. Nothing has been tracked yet (the timer boots
   * after the UI), so there is nothing for the cleanup to finalize.
   */
  async function exitAfterFailedBoot(reason: string): Promise<void> {
    quitting = true;
    deps.log.warn('exiting after failed boot', { reason });
    stopInputHook();
    await Promise.resolve(deps.flushLogs?.()).catch(() => undefined);
    deps.app.exit(1);
  }

  /** Called by the update service once electron-updater is live. */
  function attachUpdater(next: AttachedUpdater): void {
    attached = next;
    setInstallOnQuit(true, 'updates-enabled');
  }

  /**
   * Finalize ahead of an exit that something else performs (an update install,
   * Move to Applications). Pair with abortExit if that exit does not happen.
   */
  function prepareExit(reason: TimerExitReason): Promise<void> {
    return deps.runCleanup(reason);
  }

  /** The exit prepared for did not happen; the next Quit must finalize again. */
  function abortExit(reason: string): void {
    deps.log.info('prepared exit did not happen', { reason });
    deps.invalidateCleanup();
  }

  return {
    isQuitting: () => quitting,
    registerQuitHandlers,
    quit,
    relaunch,
    installUpdate,
    quitToInstallUpdate,
    endSession,
    exitAfterFailedBoot,
    attachUpdater,
    holdUpdateInstallOnQuit: (reason: string) => setInstallOnQuit(false, reason),
    allowUpdateInstallOnQuit: (reason: string) => setInstallOnQuit(true, reason),
    prepareExit,
    abortExit,
  };
}

export type AppLifecycle = ReturnType<typeof createAppLifecycle>;

function timerIsRunning(): boolean {
  try {
    return getTimerService().isRunning();
  } catch {
    return false;
  }
}

let singleton: AppLifecycle | null = null;

export function getAppLifecycle(): AppLifecycle {
  if (!singleton) {
    singleton = createAppLifecycle({
      app: app as unknown as LifecycleApp,
      platform: process.platform,
      runCleanup: runQuitCleanup,
      hasCleanupCompleted: hasQuitCleanupCompleted,
      invalidateCleanup: invalidateQuitCleanup,
      isTimerRunning: timerIsRunning,
      stopActivityCapture,
      flushLogs,
      log,
    });
  }
  return singleton;
}
