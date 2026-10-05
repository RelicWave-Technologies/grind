import { app, BrowserWindow, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import { API_URL, AUTO_UPDATE_ENABLED, UPDATE_CHANNEL, type UpdateChannel } from '../../env';
import { broadcast } from '../../broadcast';
import { log } from '../../logger';
import { drainUploads } from '../capture/uploader';
import { invalidateQuitCleanup, runQuitCleanup } from '../quitCleanup';
import { showNotification } from '../../notifications';
import { getTimerService } from '../timer';
import {
  applyUpdateEvent,
  canInstallUpdate,
  describeUpdateError,
  effectiveUpdateChannel,
  initialUpdateStatus,
  nextRetryDelayMs,
  type UpdateStatus,
} from './state';
import { detectInstallScope, type InstallScope } from './installScope';
import {
  currentInstallScope,
  getUpdateDiagnostics,
  noteInstallScope,
  noteUpdateError,
  resetUpdateDiagnosticsForTests,
} from './diagnostics';
import {
  claimLaunchInstall,
  claimMachineInstallNotice,
  createUpdateMemory,
  type UpdateMemoryStore,
} from './memory';

const FIRST_CHECK_DELAY_MS = 5_000;
const NORMAL_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const QUIET_CHECK_MIN_INTERVAL_MS = 60_000;
const INSTALL_FLUSH_TIMEOUT_MS = 5_000;
const INSTALL_RETRY_DELAY_MS = 3_000;
const INSTALL_FALLBACK_QUIT_MS = 12_000;
/**
 * An update that turns up ready this soon after launch was staged by an
 * earlier session (electron-updater re-validates its cached download within
 * seconds), so the person has not started work yet: install it now.
 */
const LAUNCH_INSTALL_WINDOW_MS = 3 * 60_000;
const MACHINE_INSTALL_NOTICE_DELAY_MS = 15_000;
const MACHINE_INSTALL_ERROR =
  'UPDATES_BLOCKED_MACHINE_INSTALL: installed for all users under Program Files; cannot update itself';

type UpdateInfoLike = { version?: string | null } | null | undefined;
type ProgressLike = { percent?: number | null };

let status: UpdateStatus = initialUpdateStatus({
  enabled: false,
  currentVersion: '0.0.0',
  channel: UPDATE_CHANNEL,
});
let started = false;
let startedAt: number | null = null;
let platform: NodeJS.Platform = process.platform;
let updateChannel: UpdateChannel = UPDATE_CHANNEL;
let installScope: InstallScope = 'unknown';
/** electron-updater reports a failed check twice (event + rejection) with the same object. */
let lastHandledError: object | null = null;
let memory: UpdateMemoryStore | null = null;
let noticeTimer: NodeJS.Timeout | null = null;
let checking = false;
let lastCheckStartedAt: number | null = null;
let firstCheckTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let installRetryTimer: NodeJS.Timeout | null = null;
let installFallbackQuitTimer: NodeJS.Timeout | null = null;
let automaticErrorCount = 0;
let readyNotificationVersion: string | null = null;
let showMainWindow: (() => void) | null = null;
let isMainWindowVisible: (() => boolean) | null = null;

function now(): number {
  return Date.now();
}

function versionOf(info: UpdateInfoLike): string | null {
  return typeof info?.version === 'string' && info.version.length > 0 ? info.version : null;
}

function currentCanInstallNow(): boolean {
  try {
    return canInstallUpdate(getTimerService().status());
  } catch {
    return true;
  }
}

function setStatus(next: UpdateStatus, opts: { notify?: boolean } = {}): UpdateStatus {
  status = next;
  if (opts.notify !== false) broadcast('updates:status:push', status);
  return status;
}

function updateStatus(event: Parameters<typeof applyUpdateEvent>[1], opts: { notify?: boolean } = {}): UpdateStatus {
  return setStatus(applyUpdateEvent(status, event), opts);
}

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function clearInstallTimers(): void {
  if (installRetryTimer) {
    clearTimeout(installRetryTimer);
    installRetryTimer = null;
  }
  if (installFallbackQuitTimer) {
    clearTimeout(installFallbackQuitTimer);
    installFallbackQuitTimer = null;
  }
}

function scheduleRetry(): void {
  clearRetryTimer();
  const delay = nextRetryDelayMs(automaticErrorCount);
  if (delay == null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void checkForUpdates(false);
  }, delay);
  log.info('update auto retry scheduled', { delayMs: delay, automaticErrorCount });
}

function handleReadyNotification(): void {
  if (status.phase !== 'ready') return;
  const version = status.availableVersion ?? 'unknown';
  if (readyNotificationVersion === version) return;
  readyNotificationVersion = version;

  if (isMainWindowVisible?.()) return;
  // Retained until clicked: an unreferenced Notification is collected after
  // show() and its click silently does nothing.
  showNotification({
    title: 'Timo update ready',
    body: 'Restart Timo when you finish tracking.',
  }, () => {
    showMainWindow?.();
    broadcast('updates:open-settings', {});
  });
}

function wireUpdaterEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    log.info('update check started', { channel: updateChannel });
  });
  autoUpdater.on('update-available', (info: UpdateInfoLike) => {
    automaticErrorCount = 0;
    clearRetryTimer();
    const next = updateStatus({ type: 'available', version: versionOf(info) });
    log.info('update available', { version: next.availableVersion, channel: next.channel });
  });
  autoUpdater.on('download-progress', (progress: ProgressLike) => {
    updateStatus({ type: 'download-progress', percent: Number(progress.percent ?? 0) });
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfoLike) => {
    automaticErrorCount = 0;
    noteUpdateError(null);
    clearRetryTimer();
    clearInstallTimers();
    const next = updateStatus({
      type: 'downloaded',
      version: versionOf(info),
      canInstallNow: currentCanInstallNow(),
      at: now(),
    });
    log.info('update downloaded', { version: next.availableVersion, canInstallNow: next.canInstallNow });
    if (maybeInstallAtLaunch()) return;
    handleReadyNotification();
  });
  autoUpdater.on('update-not-available', () => {
    automaticErrorCount = 0;
    noteUpdateError(null);
    clearRetryTimer();
    updateStatus({ type: 'not-available', manual: status.manual, at: now() });
    log.info('no update available', { channel: updateChannel });
  });
  autoUpdater.on('error', (err: Error) => {
    handleUpdateError(err, status.manual);
  });
}

function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function handleUpdateError(err: unknown, manual: boolean): void {
  // A failed check is both emitted as 'error' and thrown from checkForUpdates()
  // (electron-updater AppUpdater.checkForUpdates). Counting it twice skipped
  // the 15-minute retry and gave up after a single failure.
  if (err !== null && typeof err === 'object') {
    if (err === lastHandledError) return;
    lastHandledError = err;
  }
  const message = describeUpdateError(err);
  noteUpdateError(message);
  const installing = status.phase === 'installing';
  log.warn('update failed', {
    err: message,
    code: errorCode(err),
    phase: status.phase,
    manual,
    installing,
    channel: updateChannel,
    installScope: currentInstallScope(),
    version: status.currentVersion,
  });
  if (manual || installing) {
    clearInstallTimers();
    // The install ran the quit cleanup up front and then failed to quit. The
    // app keeps running, so that cleanup no longer stands for the next Quit.
    if (installing) invalidateQuitCleanup();
    updateStatus({ type: 'error', message, manual: true, at: now() });
    return;
  }
  automaticErrorCount += 1;
  scheduleRetry();
}

function updateMemory(): UpdateMemoryStore | null {
  if (memory) return memory;
  try {
    memory = createUpdateMemory(path.join(app.getPath('userData'), 'update-state.json'));
  } catch (err) {
    log.warn('update memory unavailable', { err: String(err) });
  }
  return memory;
}

/** The API redirect that always serves the newest published installer. */
export function installerDownloadUrl(forPlatform: NodeJS.Platform = platform): string {
  const target = forPlatform === 'darwin' ? 'mac' : 'windows';
  return `${API_URL.replace(/\/+$/, '')}/v1/downloads/agent/${target}`;
}

export async function openInstallerDownload(): Promise<{ ok: boolean }> {
  const url = installerDownloadUrl();
  try {
    await shell.openExternal(url);
    log.info('opened installer download', { url });
    return { ok: true };
  } catch (err) {
    log.warn('could not open installer download', { url, err: String(err) });
    return { ok: false };
  }
}

/**
 * One-time notice for a Program Files install. Settings keeps offering the
 * download afterwards; the dialog itself is never repeated for this install.
 */
async function showMachineInstallNotice(): Promise<void> {
  const store = updateMemory();
  if (!store || !claimMachineInstallNotice(store, process.execPath)) return;
  log.info('showing machine-install update notice', { execPath: process.execPath });
  try {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Timo',
      message: 'Timo can’t update itself here — download the new installer',
      detail:
        'Timo is installed for all users (in Program Files), so it can’t install updates on its own. ' +
        'Download and run the new installer: it installs Timo just for you, keeps your sign-in and ' +
        'your tracked time, and updates itself from then on.',
      buttons: ['Download installer', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await openInstallerDownload();
  } catch (err) {
    log.warn('machine-install update notice failed', { err: String(err) });
  }
}

/**
 * A ready update found right after launch was staged by an earlier session
 * that ended without installing it. On Windows that is the usual case, not the
 * exception: people shut down or sign off rather than Quit Timo, and Electron
 * does not emit `quit` for a Windows shutdown/sign-off, so install-on-quit
 * never runs and the update waited for a "Restart to update" click that rarely
 * came. Install it now, before the person starts tracking. Once per version,
 * so an install that fails can never turn into a restart loop.
 */
function maybeInstallAtLaunch(): boolean {
  if (platform !== 'win32' || status.phase !== 'ready' || !status.canInstallNow) return false;
  if (startedAt == null || now() - startedAt > LAUNCH_INSTALL_WINDOW_MS) return false;
  const version = status.availableVersion;
  const store = updateMemory();
  if (!version || !store || !claimLaunchInstall(store, version)) return false;
  log.info('installing staged update at launch', { version, sinceLaunchMs: now() - startedAt });
  void installUpdateNow({ silent: true, reason: 'launch' });
  return true;
}

export function startUpdateService(opts: {
  showMainWindow: () => void;
  isMainWindowVisible?: () => boolean;
  /** Test seams; production reads the real process. */
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: Record<string, string | undefined>;
  memory?: UpdateMemoryStore;
}): UpdateStatus {
  if (started) return status;
  started = true;
  startedAt = now();
  showMainWindow = opts.showMainWindow;
  isMainWindowVisible = opts.isMainWindowVisible ?? (() => BrowserWindow.getAllWindows().some((w) => w.isVisible()));
  platform = opts.platform ?? process.platform;
  if (opts.memory) memory = opts.memory;
  installScope = detectInstallScope(opts.execPath ?? process.execPath, opts.env ?? process.env, platform);
  noteInstallScope(installScope);

  const currentVersion = app.getVersion();
  updateChannel = effectiveUpdateChannel(UPDATE_CHANNEL, currentVersion);
  if (updateChannel !== UPDATE_CHANNEL) {
    log.warn('update channel follows the prerelease version', {
      bakedChannel: UPDATE_CHANNEL,
      channel: updateChannel,
      version: currentVersion,
    });
  }
  const releaseBuild = app.isPackaged && AUTO_UPDATE_ENABLED;
  const blockedReason = releaseBuild && installScope === 'machine' ? 'machine-install' as const : null;
  const enabled = releaseBuild && blockedReason === null;
  status = initialUpdateStatus({
    enabled,
    currentVersion,
    channel: updateChannel,
    canInstallNow: currentCanInstallNow(),
    installScope,
    blockedReason,
  });

  if (blockedReason) {
    // Never start electron-updater here: it runs the installer unelevated, so
    // every update of a Program Files install needs a UAC prompt at quit time —
    // one a standard user cannot answer, and an install that does not finish
    // leaves a broken app behind. Ask for a per-user reinstall instead.
    noteUpdateError(MACHINE_INSTALL_ERROR);
    log.warn('updates blocked: per-machine install cannot update itself', {
      execPath: opts.execPath ?? process.execPath,
      installScope,
      version: currentVersion,
      downloadUrl: installerDownloadUrl(),
    });
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      void showMachineInstallNotice();
    }, MACHINE_INSTALL_NOTICE_DELAY_MS);
    return status;
  }

  if (!enabled) {
    log.info('updates disabled', {
      packaged: app.isPackaged,
      autoUpdateEnabled: AUTO_UPDATE_ENABLED,
      channel: updateChannel,
      installScope,
    });
    return status;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = updateChannel === 'beta';
  autoUpdater.channel = updateChannel;
  // MUST stay after the `channel` assignment: electron-updater's channel setter
  // unconditionally flips allowDowngrade to true. Left on, a client running a
  // build newer than the newest PUBLISHED release (a draft release is invisible
  // to the updater) silently rolls itself backwards seconds after launch —
  // exactly what happened to the beta.29 testers, who landed back on beta.28.
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (msg: unknown) => log.info('electron-updater', { msg: String(msg) }),
    warn: (msg: unknown) => log.warn('electron-updater', { msg: String(msg) }),
    error: (msg: unknown) => log.error('electron-updater', { msg: String(msg) }),
    debug: (msg: unknown) => log.debug('electron-updater', { msg: String(msg) }),
  };
  wireUpdaterEvents();

  firstCheckTimer = setTimeout(() => void checkForUpdates(false), FIRST_CHECK_DELAY_MS);
  intervalTimer = setInterval(() => void checkForUpdates(false), NORMAL_CHECK_INTERVAL_MS);
  log.info('updates enabled', {
    channel: updateChannel,
    version: currentVersion,
    installScope,
    allowDowngrade: autoUpdater.allowDowngrade,
  });
  return status;
}

export { getUpdateDiagnostics };

/**
 * Windows is ending the session (shutdown, restart, sign-off). An installer
 * started now would be killed part-way — after the old version's files are
 * removed, before the new ones are written. Electron documents that `quit`
 * (which install-on-quit hangs off) is not emitted for a session end, but the
 * quit cleanup that runs here must never be the thing that starts one, so
 * install-on-quit is switched off for the rest of this process. The staged
 * update stays cached; the next launch installs it (maybeInstallAtLaunch).
 */
export function holdUpdateInstallForSessionEnd(): void {
  if (!status.enabled) return;
  autoUpdater.autoInstallOnAppQuit = false;
  log.info('update install held for session end', { phase: status.phase, version: status.availableVersion });
}

export function getUpdateStatus(): UpdateStatus {
  if (status.phase === 'ready') refreshUpdateInstallability();
  return status;
}

export async function checkForUpdates(manual: boolean): Promise<UpdateStatus> {
  if (!status.enabled) {
    return status;
  }
  if (checking) {
    return status;
  }
  checking = true;
  lastCheckStartedAt = now();
  updateStatus({ type: 'checking', manual, at: now() });
  try {
    const result = await autoUpdater.checkForUpdates();
    // The download runs on after the check resolves; its failure arrives as an
    // 'error' event. Without this its rejected promise is also left unhandled.
    result?.downloadPromise?.catch(() => undefined);
  } catch (err) {
    handleUpdateError(err, manual);
  } finally {
    checking = false;
  }
  return status;
}

export async function checkForUpdatesQuietly(reason = 'quiet'): Promise<UpdateStatus> {
  if (!status.enabled || checking) return status;
  if (status.phase === 'available' || status.phase === 'downloading' || status.phase === 'ready' || status.phase === 'installing') {
    return status;
  }
  const ageMs = lastCheckStartedAt == null ? Number.POSITIVE_INFINITY : now() - lastCheckStartedAt;
  if (ageMs < QUIET_CHECK_MIN_INTERVAL_MS) return status;
  log.info('quiet update check requested', { reason, ageMs: Number.isFinite(ageMs) ? ageMs : null });
  return checkForUpdates(false);
}

export function refreshUpdateInstallability(): UpdateStatus {
  const canInstallNow = currentCanInstallNow();
  if (status.canInstallNow !== canInstallNow) {
    updateStatus({ type: 'timer-changed', canInstallNow });
  }
  return status;
}

function withTimeout<T>(label: string, task: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    task.then((value) => {
      if (timer) clearTimeout(timer);
      return value;
    }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        log.warn('update install flush timed out', { label, ms });
        resolve(null);
      }, ms);
    }),
  ]);
}

export async function flushBeforeUpdateInstall(): Promise<void> {
  await runQuitCleanup('update');

  await withTimeout('screenshot queue', drainUploads(), INSTALL_FLUSH_TIMEOUT_MS).catch((err) => {
    log.warn('update flush screenshots failed', { err: String(err) });
  });
}

function requestQuitAndInstall(reason: string, silent = false): void {
  try {
    if (process.platform === 'darwin') {
      // On macOS the native updater can still be staging when electron-updater
      // emits "update-downloaded". Toggling this before a manual install makes
      // MacUpdater ask the native updater to finish preparing instead of
      // waiting quietly for a later app quit.
      autoUpdater.autoInstallOnAppQuit = false;
    }
    log.info('requesting downloaded update install', {
      reason,
      silent,
      version: status.availableVersion,
      channel: status.channel,
      platform: process.platform,
    });
    // isForceRunAfter: Timo comes back up after the installer finishes.
    autoUpdater.quitAndInstall(silent, true);
  } catch (err) {
    handleUpdateError(err, true);
  }
}

function scheduleInstallFallbacks(reason: string, silent: boolean): void {
  clearInstallTimers();
  installRetryTimer = setTimeout(() => {
    installRetryTimer = null;
    if (status.phase !== 'installing') return;
    requestQuitAndInstall(`${reason}-retry`, silent);
  }, INSTALL_RETRY_DELAY_MS);

  installFallbackQuitTimer = setTimeout(() => {
    installFallbackQuitTimer = null;
    if (status.phase !== 'installing') return;
    log.warn('update install request did not quit app; falling back to app quit', {
      version: status.availableVersion,
      channel: status.channel,
      platform: process.platform,
    });
    autoUpdater.autoInstallOnAppQuit = true;
    app.quit();
  }, INSTALL_FALLBACK_QUIT_MS);
}

/** True from the moment an install starts until it quits or fails. */
export function isInstallingUpdate(): boolean {
  return status.phase === 'installing';
}

/**
 * Install the ready update now. A person's click runs the installer with its
 * window (progress is visible); the launch-time install runs it silently.
 */
export async function installUpdateNow(
  opts: { silent?: boolean; reason?: string } = {},
): Promise<UpdateStatus> {
  refreshUpdateInstallability();
  if (status.phase === 'installing') return status;
  if (!status.enabled || status.phase !== 'ready' || !status.canInstallNow) return status;
  const reason = opts.reason ?? 'manual';
  const silent = opts.silent ?? false;
  updateStatus({ type: 'installing', at: now() });
  await flushBeforeUpdateInstall();
  scheduleInstallFallbacks(reason, silent);
  requestQuitAndInstall(reason, silent);
  return status;
}

/**
 * Called just before a permission "Restart Timo". With autoInstallOnAppQuit on,
 * a staged update can start installing while app.relaunch() brings the old
 * binary back up — on a slow disk the two race. A ready update takes the
 * restart over instead (quitAndInstall relaunches on its own); otherwise
 * install-on-quit is switched off for this exit, and the next launch turns it
 * back on. Returns true when the update install owns the restart.
 */
export async function installUpdateInsteadOfRelaunch(): Promise<boolean> {
  if (!status.enabled) return false;
  if ((await installUpdateNow()).phase === 'installing') return true;
  autoUpdater.autoInstallOnAppQuit = false;
  return false;
}

export function stopUpdateServiceForTests(): void {
  if (firstCheckTimer) clearTimeout(firstCheckTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  if (noticeTimer) clearTimeout(noticeTimer);
  clearRetryTimer();
  clearInstallTimers();
  firstCheckTimer = null;
  intervalTimer = null;
  noticeTimer = null;
  started = false;
  startedAt = null;
  installScope = 'unknown';
  lastHandledError = null;
  resetUpdateDiagnosticsForTests();
  memory = null;
}
