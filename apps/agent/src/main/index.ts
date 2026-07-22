import { app, ipcMain, Notification, safeStorage, screen } from 'electron';
import type { BrowserWindow, Tray } from 'electron';
import { createTray, setTrayTitle } from './tray';
import { createMainWindow } from './window';
import { registerIpc } from './ipc';
import { sendHeartbeatNow, startHeartbeatIfAuthed } from './services/heartbeat';
import {
  applyTodayLedgerMode,
  drainTimerSyncNow,
  getTimerService,
  initTimerOnBoot,
  refreshTodayLedger,
  startTimerSyncDrain,
} from './services/timer';
import { rescheduleCaptureLoop, startCaptureLoop } from './services/capture';
import {
  applyActivityCapturePolicy,
  drainActivityNow,
  onTrackedInputActivity,
  startActivityCapture,
  startActivitySyncDrain,
  setActivityRecording,
} from './services/activity';
import { startActiveWindowPolling } from './services/activity/windowPoller';
import { registerPowerEvents } from './services/power';
import { IdleMonitor } from './services/idle/monitor';
import { dismissFloatingBar, reclampFloatingBar, syncFloatingBar } from './floating';
import { reassertAllOverlays } from './windows/overlay';
import { ensureRegularMacApplication } from './windows/macAppIdentity';
import { togglePopover, hidePopover } from './popover';
import { reassertAttentionWindow } from './attentionWindow';
import { getTrackingAttentionCoordinator } from './services/trackingAttention';
import { ShiftMonitor } from './services/shift';
import { onAuthChange } from './services/apiClient';
import { isLoggedIn } from './services/auth';
import { onAgentConfigChange, refreshAgentConfig } from './services/agentConfig';
import {
  registerProtocol,
  handleDeepLink,
  deepLinkFromArgv,
  flushQueuedDeepLink,
  setLarkConnectionHandler,
} from './services/deepLink';
import { hasQuitCleanupCompleted, registerGracefulQuitHandler, runQuitCleanup } from './services/quitCleanup';
import {
  getUpdateStatus,
  installUpdateNow,
  refreshUpdateInstallability,
  startUpdateService,
} from './services/updates';
import { getLaunchAtLoginService, isHiddenLaunch } from './services/launchAtLogin';
import type { LaunchAtLoginHealth } from '../shared/launchAtLogin';
import { migrateLegacyUserData } from './services/legacyMigration';
import { broadcast } from './broadcast';
import {
  offerPermissionStart,
  offerPermissionSetupOnStartup,
  resetPermissionSetupOffer,
} from './services/trackingCommands';
import {
  checkTrackingPermissionsNow,
  startTrackingPermissionMonitor,
} from './services/trackingPermissionMonitor';
import { API_URL, CALLBACK_SCHEME } from './env';
import { log, logFilePath } from './logger';
import {
  clearWorkspaceTimeSession,
  initializeWorkspaceTime,
  onWorkspaceTimeChange,
} from './services/workspaceTime';

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

function attachMainWindowHandlers(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

function ensureMainWindow(opts: { startHidden?: boolean } = {}): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = createMainWindow(opts);
  attachMainWindowHandlers(mainWindow);
  return mainWindow;
}

function showMainWindow(opts: { bypassAttention?: boolean } = {}) {
  if (isQuitting) return;
  if (!opts.bypassAttention && getTrackingAttentionCoordinator().restoreActive()) return;
  const win = ensureMainWindow({ startHidden: true });
  hidePopover();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showSettingsWindow() {
  showMainWindow({ bypassAttention: true });
  broadcast('settings:open:push', {});
}

function notifyStartupHealth(state: LaunchAtLoginHealth): void {
  if (state.ready || state.state === 'UNAVAILABLE' || state.openedAtLogin || !Notification.isSupported()) return;
  const body = state.state === 'NEEDS_INSTALL'
    ? 'Move Timo to Applications so it can start when you sign in.'
    : state.state === 'NEEDS_APPROVAL'
      ? 'Approve Timo in Login Items so it can start when you sign in.'
      : 'Open Timo Settings to repair Launch at Login.';
  const notification = new Notification({
    title: 'Timo startup needs attention',
    body,
  });
  notification.on('click', showSettingsWindow);
  notification.show();
}

app.whenReady().then(async () => {
  // Timo has a Dock icon, a main window, and normal Cmd+Tab behavior. Overlay
  // setup must never leave the whole app in macOS's UIElement utility mode.
  ensureRegularMacApplication();

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

  const launchAtLoginService = getLaunchAtLoginService();
  const openedAtLogin = launchAtLoginService.shouldStartHidden();
  const launchAtLogin = launchAtLoginService.reconcileOnBoot();

  mainWindow = ensureMainWindow({ startHidden: openedAtLogin });
  setLarkConnectionHandler(() => showMainWindow());
  const attention = getTrackingAttentionCoordinator();
  tray = createTray({
    onToggle: (bounds) => {
      if (!attention.restoreActive()) togglePopover(bounds);
    },
    onOpenMain: () => showMainWindow(),
    onInstallUpdate: () => void installUpdateNow(),
    getUpdateStatus: () => getUpdateStatus(),
  });
  // Idle detection optionally warns first, then performs the same durable pause
  // at the real idle boundary. Both stages share the single attention window.
  const idleMonitor = new IdleMonitor({
    onWarning: ({ idleStartedAt, deadlineAt }) =>
      attention.requestIdleWarning({ idleStartedAt, deadlineAt }),
    onWarningCancelled: () => {
      attention.clearIdleWarning();
    },
    onIdle: async (idleStartedAt) => {
      try {
        await getTimerService().pauseForIdle(idleStartedAt);
      } catch (err) {
        log.warn('pauseForIdle failed', { err: String(err) });
        return false;
      }
      const accepted = attention.requestIdle(idleStartedAt);
      broadcast('timer:status:push', getTimerService().status());
      sendHeartbeatNow();
      return accepted;
    },
  });
  idleMonitor.start();
  onTrackedInputActivity(() => idleMonitor.noteActivity());

  registerIpc({
    onOpenMainWindow: () => showMainWindow(),
    onDismissFloatingBar: () => dismissFloatingBar(),
    onIdleResolved: () => idleMonitor.resolve(),
  });
  onWorkspaceTimeChange((context) => {
    broadcast('workspaceTime:push', context);
    if (context.ready) void refreshTodayLedger('config');
  });
  startUpdateService({
    showMainWindow: () => showMainWindow(),
    isMainWindowVisible: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(),
  });

  // Deep-link delivery is now safe (window + IPC are up). Process any Lark login
  // callback ASAP — BEFORE the heavy awaited boot work below — so a slow network
  // call can't delay or drop it. Flush anything queued during boot (macOS
  // open-url) and pick up a cold-start argv link (Windows/Linux).
  flushQueuedDeepLink();
  const coldStartLink = deepLinkFromArgv(process.argv);
  if (coldStartLink) void handleDeepLink(coldStartLink);

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
  app.on('activate', () => {
    showMainWindow();
  });

  // On wake the OS drops the always-on-top / all-Spaces flags (electron#36364)
  // — re-assert float on EVERY live overlay, not just the bar.
  registerPowerEvents({
    onAwayStart: () => {
      idleMonitor.suspend();
      attention.beginMachineAway();
    },
    onWake: () => {
      reassertAllOverlays();
      reassertAttentionWindow({ refreshWorkspaceVisibility: true });
      checkTrackingPermissionsNow();
      void drainTimerSyncNow('wake');
      void refreshTodayLedger('wake');
      void drainActivityNow('wake');
    },
    // `resume` can arrive while macOS still owns the lock screen. Reassert once
    // more on the distinct unlock signal without running timer recovery twice.
    onVisibilityReturn: () => reassertAttentionWindow({ refreshWorkspaceVisibility: true }),
    // Returned from a lock/sleep that stopped a running timer → offer to resume.
    onReturnFromAway: (info) => {
      if (attention.isPermissionActive()) offerPermissionStart(info.larkTaskGuid);
      else attention.requestAway(info);
    },
    onReturnComplete: () => idleMonitor.resume(),
  });

  // When monitors change (unplug / resolution switch): re-float all overlays
  // and re-home the floating bar onto a still-visible display.
  screen.on('display-removed', () => {
    reclampFloatingBar();
    reassertAllOverlays();
    reassertAttentionWindow({ refreshWorkspaceVisibility: true });
  });
  screen.on('display-metrics-changed', () => {
    reclampFloatingBar();
    reassertAllOverlays();
    reassertAttentionWindow({ refreshWorkspaceVisibility: true });
  });
  screen.on('display-added', () => {
    reassertAllOverlays();
    reassertAttentionWindow({ refreshWorkspaceVisibility: true });
  });

  onAgentConfigChange(({ previous, current }) => {
    applyActivityCapturePolicy(current);
    applyTodayLedgerMode(current.todayLedgerMode);
    if (!previous || previous.screenshotIntervalSec !== current.screenshotIntervalSec) {
      rescheduleCaptureLoop('agent-config');
    }
  });

  // Resolve the canonical workspace clock before timer recovery and renderer
  // totals. A validated on-disk timezone is available immediately offline;
  // an online config refresh upgrades it to the current server value.
  try {
    await initializeWorkspaceTime();
    await refreshAgentConfig();
  } catch (err) {
    log.warn('refreshAgentConfig failed', { err: String(err) });
  }

  try {
    await initTimerOnBoot();
    startTimerSyncDrain();
    void refreshTodayLedger('boot');
  } catch (err) {
    log.warn('initTimerOnBoot failed', { err: String(err) });
  }
  try {
    await startHeartbeatIfAuthed();
  } catch (err) {
    log.warn('startHeartbeatIfAuthed failed', { err: String(err) });
  }

  startCaptureLoop();
  startActivityCapture();
  startTrackingPermissionMonitor();
  if (await isLoggedIn()) void offerPermissionSetupOnStartup();
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
      void offerPermissionSetupOnStartup();
    } else {
      clearWorkspaceTimeSession();
      resetPermissionSetupOffer();
    }
  });
  ipcMain.handle('shift:decide', (_e, decision: 'yes' | 'not_yet') => {
    shiftMonitor.onUserDecision(decision);
  });
  ipcMain.handle('shift:refresh', () => shiftMonitor.refreshShift());
  ipcMain.handle('shift:today', async () => {
    await shiftMonitor.refreshShift();
    return shiftMonitor.todayWindow();
  });

  // Single 1s heartbeat: tray ticker + floating-bar visibility + live broadcast
  // + a throttled durable liveness tick (crash-recovery bound).
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
      syncFloatingBar(s);
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
    launchAtLoginStatus: launchAtLogin.state,
  });
  notifyStartupHealth(launchAtLogin);
});

app.on('window-all-closed', () => {
  // Stay alive in the tray.
});
// On Windows/Linux the deep-link arrives as argv of a second launch.
app.on('second-instance', (_e, argv) => {
  const url = deepLinkFromArgv(argv);
  if (url) void handleDeepLink(url);
  if (!isHiddenLaunch(argv)) showMainWindow();
});

void tray;
