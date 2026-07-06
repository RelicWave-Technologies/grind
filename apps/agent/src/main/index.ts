import { app, ipcMain, safeStorage, screen } from 'electron';
import type { BrowserWindow, Tray } from 'electron';
import { createTray, setTrayTitle } from './tray';
import { createMainWindow } from './window';
import { registerIpc } from './ipc';
import { sendHeartbeatNow, startHeartbeatIfAuthed } from './services/heartbeat';
import { drainTimerSyncNow, getTimerService, initTimerOnBoot, startTimerSyncDrain } from './services/timer';
import { rescheduleCaptureLoop, startCaptureLoop } from './services/capture';
import {
  applyActivityCapturePolicy,
  drainActivityNow,
  startActivityCapture,
  startActivitySyncDrain,
  setActivityRecording,
} from './services/activity';
import { startActiveWindowPolling } from './services/activity/windowPoller';
import { registerPowerEvents } from './services/power';
import { IdleMonitor } from './services/idle/monitor';
import { showFloatingBar, hideFloatingBar, reclampFloatingBar } from './floating';
import { reassertAllOverlays } from './windows/overlay';
import { togglePopover, hidePopover } from './popover';
import { showIdlePrompt, hideIdlePrompt } from './idlePrompt';
import { ShiftMonitor } from './services/shift';
import { onAuthChange } from './services/apiClient';
import { onAgentConfigChange, refreshAgentConfig } from './services/agentConfig';
import { registerProtocol, handleDeepLink, deepLinkFromArgv, flushQueuedDeepLink } from './services/deepLink';
import { hasQuitCleanupCompleted, registerGracefulQuitHandler, runQuitCleanup } from './services/quitCleanup';
import {
  getUpdateStatus,
  installUpdateNow,
  refreshUpdateInstallability,
  startUpdateService,
} from './services/updates';
import { ensureLaunchAtLogin, shouldStartHidden } from './services/launchAtLogin';
import { migrateLegacyUserData } from './services/legacyMigration';
import { broadcast } from './broadcast';
import { API_URL, CALLBACK_SCHEME } from './env';
import { log, logFilePath } from './logger';

function fmtShort(ms: number): string {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Register the custom auth callback for Lark login. Must happen before whenReady, and the
// macOS open-url handler must be attached early — the OS can deliver the
// deep-link before the app finishes booting (handleDeepLink queues it).
const protocolRegistered = registerProtocol();
app.on('open-url', (event, url) => {
  event.preventDefault();
  void handleDeepLink(url);
});

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

function showMainWindow() {
  if (!mainWindow) return;
  hidePopover();
  mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(async () => {
  // Recover a session stranded by a prior app identity (Grind->Timo) BEFORE any
  // token read. Windows-only: that's where the productName-based userData dir
  // moved and orphaned tokens.bin.
  if (process.platform === 'win32') migrateLegacyUserData();

  // Boot diagnostics — the first line in every log file. Pinpoints the two
  // known Windows failure modes at a glance: a moved data dir (userData /
  // appName after the rebrand) and an unregistered deep-link scheme
  // (protocolRegistered / isDefaultProtocolClient false ⇒ Lark login can't
  // complete). Also confirms the baked API_URL/scheme and token encryption.
  log.info('boot diagnostics', {
    platform: process.platform,
    arch: process.arch,
    appName: app.getName(),
    version: app.getVersion(),
    userData: app.getPath('userData'),
    logFile: logFilePath(),
    apiUrl: API_URL,
    callbackScheme: CALLBACK_SCHEME,
    protocolRegistered,
    isDefaultProtocolClient: app.isDefaultProtocolClient(CALLBACK_SCHEME),
    safeStorageAvailable: safeStorage.isEncryptionAvailable(),
  });

  const launchAtLogin = ensureLaunchAtLogin();
  const openedAtLogin = shouldStartHidden(process.argv);

  mainWindow = createMainWindow({ startHidden: openedAtLogin });
  tray = createTray({
    onToggle: (bounds) => togglePopover(bounds),
    onOpenMain: () => showMainWindow(),
    onInstallUpdate: () => void installUpdateNow(),
    getUpdateStatus: () => getUpdateStatus(),
  });
  registerIpc({ onOpenMainWindow: () => showMainWindow() });
  startUpdateService({
    showMainWindow: () => showMainWindow(),
    isMainWindowVisible: () => !!mainWindow?.isVisible(),
  });

  // Deep-link delivery is now safe (window + IPC are up). Process any Lark login
  // callback ASAP — BEFORE the heavy awaited boot work below — so a slow network
  // call can't delay or drop it. Flush anything queued during boot (macOS
  // open-url) and pick up a cold-start argv link (Windows/Linux).
  flushQueuedDeepLink();
  const coldStartLink = deepLinkFromArgv(process.argv);
  if (coldStartLink) void handleDeepLink(coldStartLink);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  registerGracefulQuitHandler({
    app,
    hasCleanupCompleted: () => hasQuitCleanupCompleted(),
    markQuitting: () => {
      isQuitting = true;
    },
  });
  (app as Electron.App & { on(event: 'before-quit-for-update', listener: () => void): Electron.App }).on('before-quit-for-update', () => {
    isQuitting = true;
    void runQuitCleanup('update');
  });
  app.on('activate', () => showMainWindow());

  // On wake the OS drops the always-on-top / all-Spaces flags (electron#36364)
  // — re-assert float on EVERY live overlay, not just the bar.
  registerPowerEvents({
    onWake: () => {
      reassertAllOverlays();
      void drainTimerSyncNow('wake');
      void drainActivityNow('wake');
    },
  });

  // When monitors change (unplug / resolution switch): re-float all overlays
  // and re-home the floating bar onto a still-visible display.
  screen.on('display-removed', () => {
    reclampFloatingBar();
    reassertAllOverlays();
  });
  screen.on('display-metrics-changed', () => {
    reclampFloatingBar();
    reassertAllOverlays();
  });
  screen.on('display-added', () => reassertAllOverlays());

  // Idle detection → pause the timer (idle is never counted) and prompt.
  const idleMonitor = new IdleMonitor(async (idleStartedAt) => {
    try {
      await getTimerService().pauseForIdle(idleStartedAt);
    } catch (err) {
      log.warn('pauseForIdle failed', { err: String(err) });
    }
    broadcast('timer:status:push', getTimerService().status());
    sendHeartbeatNow();
    showIdlePrompt();
  });
  idleMonitor.start();

  ipcMain.handle('idle:get', () => ({ idleStartedAt: idleMonitor.getIdleStart() }));
  ipcMain.handle('idle:resolve', async (_e, action: 'continue' | 'break') => {
    try {
      if (action === 'continue') await getTimerService().resume();
      else await getTimerService().stop();
    } catch (err) {
      log.warn('idle resolve failed', { action, err: String(err) });
    }
    idleMonitor.resolve();
    hideIdlePrompt();
    broadcast('timer:status:push', getTimerService().status());
    sendHeartbeatNow();
    refreshUpdateInstallability();
  });

  onAgentConfigChange(({ previous, current }) => {
    applyActivityCapturePolicy(current);
    if (!previous || previous.screenshotIntervalSec !== current.screenshotIntervalSec) {
      rescheduleCaptureLoop('agent-config');
    }
  });

  try {
    await initTimerOnBoot();
    startTimerSyncDrain();
  } catch (err) {
    log.warn('initTimerOnBoot failed', { err: String(err) });
  }
  try {
    await startHeartbeatIfAuthed();
  } catch (err) {
    log.warn('startHeartbeatIfAuthed failed', { err: String(err) });
  }

  // Pull the server-driven capture cadence + idle threshold (per-user →
  // workspace policy) BEFORE the capture loop schedules its first shot, so the
  // first interval already reflects policy. No-ops (keeps defaults) if logged
  // out; a failure here must not abort the rest of boot.
  try {
    await refreshAgentConfig();
  } catch (err) {
    log.warn('refreshAgentConfig failed', { err: String(err) });
  }

  startCaptureLoop();
  startActivityCapture();
  startActivitySyncDrain();
  void drainActivityNow('boot');
  startActiveWindowPolling();

  // Shift monitor — fetches the user's assigned shift and fires the
  // "Ready to work?" toast at start time (+ 5-min nudges until buffer
  // expiry). Safely no-ops if the user is not logged in or unassigned.
  const shiftMonitor = new ShiftMonitor(() => showMainWindow());
  try {
    await shiftMonitor.start();
  } catch (err) {
    log.warn('shift monitor start failed', { err: String(err) });
  }
  // Re-fetch the shift + capture config whenever auth state flips (login/refresh).
  onAuthChange((status) => {
    if (status === 'loggedIn') {
      void shiftMonitor.refreshShift();
      void refreshAgentConfig();
      void drainActivityNow('auth');
    }
  });
  ipcMain.handle('shift:decide', (_e, decision: 'yes' | 'not_yet') => {
    shiftMonitor.onUserDecision(decision);
  });
  ipcMain.handle('shift:refresh', () => shiftMonitor.refreshShift());

  // Single 1s heartbeat: tray ticker + floating-bar visibility + live broadcast
  // + a throttled durable liveness tick (crash-recovery bound).
  let lastRunning = false;
  let tick = 0;
  const LIVENESS_EVERY_TICKS = 15; // persist "proof of life" ~every 15s
  setInterval(() => {
    try {
      tick += 1;
      const s = getTimerService().status();
      refreshUpdateInstallability();
      const running = s.state === 'RUNNING';
      const accruing = running && !s.paused;
      setActivityRecording(accruing, running ? s.entryId : null);
      if (tray) setTrayTitle(tray, running ? fmtShort(s.workedMs) : '');
      if (running) showFloatingBar();
      else if (lastRunning) hideFloatingBar();
      lastRunning = running;
      if (running) broadcast('timer:status:push', s);
      // Liveness: only while genuinely accruing, throttled. The next boot
      // closes any dangling entry at the last tick so a crash/hard-off never
      // over-credits the dead gap. Worst-case over-count ≈ 15s.
      if (accruing && tick % LIVENESS_EVERY_TICKS === 0) {
        getTimerService().heartbeat();
      }
    } catch {
      /* timer not ready */
    }
  }, 1000);

  log.info('agent ready', {
    platform: process.platform,
    version: app.getVersion(),
    openedAtLogin,
    launchAtLoginStatus: launchAtLogin.status,
  });
});

app.on('window-all-closed', () => {
  // Stay alive in the tray.
});
// On Windows/Linux the deep-link arrives as argv of a second launch.
app.on('second-instance', (_e, argv) => {
  const url = deepLinkFromArgv(argv);
  if (url) void handleDeepLink(url);
  showMainWindow();
});

void tray;
