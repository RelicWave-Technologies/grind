import { app, BrowserWindow, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import { AUTO_UPDATE_ENABLED, UPDATE_CHANNEL } from '../../env';
import { broadcast } from '../../broadcast';
import { log } from '../../logger';
import { drainUploads } from '../capture/uploader';
import { runQuitCleanup } from '../quitCleanup';
import { getTimerService } from '../timer';
import {
  applyUpdateEvent,
  canInstallUpdate,
  initialUpdateStatus,
  nextRetryDelayMs,
  type UpdateStatus,
} from './state';

const FIRST_CHECK_DELAY_MS = 5_000;
const NORMAL_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const QUIET_CHECK_MIN_INTERVAL_MS = 60_000;
const INSTALL_FLUSH_TIMEOUT_MS = 5_000;
const INSTALL_RETRY_DELAY_MS = 3_000;
const INSTALL_FALLBACK_QUIT_MS = 12_000;

type UpdateInfoLike = { version?: string | null } | null | undefined;
type ProgressLike = { percent?: number | null };

let status: UpdateStatus = initialUpdateStatus({
  enabled: false,
  currentVersion: '0.0.0',
  channel: UPDATE_CHANNEL,
});
let started = false;
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

  if (isMainWindowVisible?.() || !Notification.isSupported()) return;
  const notification = new Notification({
    title: 'Timo update ready',
    body: 'Restart Timo when you finish tracking.',
  });
  notification.on('click', () => {
    showMainWindow?.();
    broadcast('updates:open-settings', {});
  });
  notification.show();
}

function wireUpdaterEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    log.info('update check started', { channel: UPDATE_CHANNEL });
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
    clearRetryTimer();
    clearInstallTimers();
    const next = updateStatus({
      type: 'downloaded',
      version: versionOf(info),
      canInstallNow: currentCanInstallNow(),
      at: now(),
    });
    log.info('update downloaded', { version: next.availableVersion, canInstallNow: next.canInstallNow });
    handleReadyNotification();
  });
  autoUpdater.on('update-not-available', () => {
    automaticErrorCount = 0;
    clearRetryTimer();
    updateStatus({ type: 'not-available', manual: status.manual, at: now() });
    log.info('no update available', { channel: UPDATE_CHANNEL });
  });
  autoUpdater.on('error', (err: Error) => {
    handleUpdateError(err, status.manual);
  });
}

function handleUpdateError(err: unknown, manual: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  const installing = status.phase === 'installing';
  log.warn('update check failed', { err: message, manual, installing });
  if (manual || installing) {
    clearInstallTimers();
    updateStatus({ type: 'error', message, manual: true, at: now() });
    return;
  }
  automaticErrorCount += 1;
  scheduleRetry();
}

export function startUpdateService(opts: {
  showMainWindow: () => void;
  isMainWindowVisible?: () => boolean;
}): UpdateStatus {
  if (started) return status;
  started = true;
  showMainWindow = opts.showMainWindow;
  isMainWindowVisible = opts.isMainWindowVisible ?? (() => BrowserWindow.getAllWindows().some((w) => w.isVisible()));

  const enabled = app.isPackaged && AUTO_UPDATE_ENABLED;
  status = initialUpdateStatus({
    enabled,
    currentVersion: app.getVersion(),
    channel: UPDATE_CHANNEL,
    canInstallNow: currentCanInstallNow(),
  });

  if (!enabled) {
    log.info('updates disabled', {
      packaged: app.isPackaged,
      autoUpdateEnabled: AUTO_UPDATE_ENABLED,
      channel: UPDATE_CHANNEL,
    });
    return status;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = UPDATE_CHANNEL === 'beta';
  autoUpdater.channel = UPDATE_CHANNEL;
  autoUpdater.logger = {
    info: (msg: unknown) => log.info('electron-updater', { msg: String(msg) }),
    warn: (msg: unknown) => log.warn('electron-updater', { msg: String(msg) }),
    error: (msg: unknown) => log.error('electron-updater', { msg: String(msg) }),
    debug: (msg: unknown) => log.debug('electron-updater', { msg: String(msg) }),
  };
  wireUpdaterEvents();

  firstCheckTimer = setTimeout(() => void checkForUpdates(false), FIRST_CHECK_DELAY_MS);
  intervalTimer = setInterval(() => void checkForUpdates(false), NORMAL_CHECK_INTERVAL_MS);
  log.info('updates enabled', { channel: UPDATE_CHANNEL, version: app.getVersion() });
  return status;
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
    await autoUpdater.checkForUpdates();
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

function requestQuitAndInstall(reason: string): void {
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
      version: status.availableVersion,
      channel: status.channel,
      platform: process.platform,
    });
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    handleUpdateError(err, true);
  }
}

function scheduleInstallFallbacks(): void {
  clearInstallTimers();
  installRetryTimer = setTimeout(() => {
    installRetryTimer = null;
    if (status.phase !== 'installing') return;
    requestQuitAndInstall('manual-retry');
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

export async function installUpdateNow(): Promise<UpdateStatus> {
  refreshUpdateInstallability();
  if (status.phase === 'installing') return status;
  if (!status.enabled || status.phase !== 'ready' || !status.canInstallNow) return status;
  updateStatus({ type: 'installing', at: now() });
  await flushBeforeUpdateInstall();
  scheduleInstallFallbacks();
  requestQuitAndInstall('manual');
  return status;
}

export function stopUpdateServiceForTests(): void {
  if (firstCheckTimer) clearTimeout(firstCheckTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  clearRetryTimer();
  clearInstallTimers();
  firstCheckTimer = null;
  intervalTimer = null;
  started = false;
}
