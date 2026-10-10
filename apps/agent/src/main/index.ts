import { app, BrowserWindow, dialog, ipcMain, safeStorage, screen } from 'electron';
import type { MessageBoxOptions, RenderProcessGoneDetails, Tray, WebContents } from 'electron';
import { createTray, setTrayTitle } from './tray';
import { createMainWindow } from './window';
import {
  decidePromptGate,
  PROMPT_UNREACHABLE_WINDOW_MS,
} from './services/promptReachability';
import { registerIpc } from './ipc';
import { sendHeartbeatNow, startHeartbeat } from './services/heartbeat';
import { noteSystemResumed, setServerClockTrackingActive } from './services/serverClock';
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
import { getTrackingAttentionCoordinator } from './services/trackingAttention';
import { ShiftMonitor } from './services/shift';
import { onAuthChange } from './services/apiClient';
import { loadTokens } from './services/tokenStore';
import { onAgentConfigChange, refreshAgentConfig } from './services/agentConfig';
import {
  registerProtocol,
  handleDeepLink,
  deepLinkFromArgv,
  flushQueuedDeepLink,
  setLarkConnectionHandler,
} from './services/deepLink';
import { attachWindowsSessionEnd, type SessionEndHandlers } from './services/updates/sessionEnd';
import { getAppLifecycle } from './appLifecycle';
import { guardBootStep, uiBootOutcome } from './bootGuard';
import { registerChildProcessCrashLogging, setUpCrashHandlingBeforeReady } from './crashHandling';
import { showNotification } from './notifications';
import { runBoot } from './boot';
import {
  getUpdateStatus,
  installUpdateNow,
  refreshUpdateInstallability,
  startUpdateService,
} from './services/updates';
import { getLaunchAtLoginService, isHiddenLaunch } from './services/launchAtLogin';
import type { LaunchAtLoginHealth } from '../shared/launchAtLogin';
import type { createLaunchAtLoginService } from './services/launchAtLogin';
import { migrateLegacyUserData } from './services/legacyMigration';
import { broadcast } from './broadcast';
import { placeReadyToWorkOnScreen, readyToWorkReason } from './readyToWork';
import { installApplicationMenu, quitFromMenu } from './applicationMenu';
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

// Before ready: native crash dumps (kept local), and the GPU safe mode a
// crashing GPU process earned on the previous run.
setUpCrashHandlingBeforeReady();
const lifecycle = getAppLifecycle();

// A stray throw or rejection anywhere in the main process used to end up as
// Electron's default crash dialog (or, for a rejection, nowhere at all). Log it
// with enough to diagnose and keep running: the timer, the queues, and the
// tray are all still fine, and quitting would cut off tracked time.
process.on('uncaughtException', (err) => {
  log.error('uncaught exception in main process', { err: String(err), stack: err?.stack ?? null });
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection in main process', {
    err: String(reason),
    stack: reason instanceof Error ? reason.stack ?? null : null,
  });
});

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
/** Window + tray exist, so showing the main window is safe. */
let uiReady = false;
/** A second launch asked for the window before the UI existed. */
let showMainWhenReady = false;

function attachMainWindowHandlers(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (!lifecycle.isQuitting()) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

const windowsSessionEndHandlers: SessionEndHandlers = {
  onQueryEnd: () => {
    // The shutdown can still be vetoed by another app; only refresh the
    // proof of life so recovery is exact if Windows kills us mid-way.
    const timer = getTimerService();
    if (timer.isRunning() && !timer.isPaused()) timer.heartbeat();
  },
  // Never lets a staged update start installing as Windows tears the session
  // down (the next launch installs it), then finalizes tracked time.
  onEnd: () => void lifecycle.endSession('windows-session-end'),
};

/**
 * Windows shutdown/sign-off: powerMonitor 'shutdown' does not fire there, so
 * the session end arrives as window messages. The hook used to hang off the
 * main window — which no longer exists once the renderer crash limit is hit —
 * so a hidden window that never loads anything owns it for the whole run.
 */
let sessionEndWindow: BrowserWindow | null = null;
function watchWindowsSessionEnd(): void {
  if (process.platform !== 'win32' || sessionEndWindow) return;
  try {
    sessionEndWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    attachWindowsSessionEnd(sessionEndWindow, windowsSessionEndHandlers);
  } catch (err) {
    log.warn('session-end window unavailable; watching from the main window', { err: String(err) });
    if (mainWindow && !mainWindow.isDestroyed()) attachWindowsSessionEnd(mainWindow, windowsSessionEndHandlers);
  }
}

/** Cmd+Q while tracking asks first; two presses never stack two dialogs. */
let quitConfirmOpen = false;
async function confirmQuitWhileTracking(): Promise<boolean> {
  if (quitConfirmOpen) return false;
  quitConfirmOpen = true;
  try {
    const options: MessageBoxOptions = {
      type: 'question',
      message: 'Quit Timo while tracking?',
      detail: 'Your timer is running. Quitting Timo stops it now.',
      buttons: ['Quit Timo', 'Keep Tracking'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    // Attached to the focused window (often the prompt that caught the
    // keystroke) so it cannot open behind an always-on-top surface.
    const parent = BrowserWindow.getFocusedWindow();
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return response === 0;
  } finally {
    quitConfirmOpen = false;
  }
}

function quitFromAppMenu(): void {
  void quitFromMenu({
    isTimerRunning: () => getTimerService().status().state === 'RUNNING',
    confirm: confirmQuitWhileTracking,
    quit: () => lifecycle.quit('menu'),
  }).catch((err) => log.warn('menu quit failed', { err: String(err) }));
}

function ensureMainWindow(opts: { startHidden?: boolean } = {}): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = createMainWindow(opts);
  attachMainWindowHandlers(mainWindow);
  return mainWindow;
}

/** When we last re-presented a prompt because somebody asked for the app. */
let lastPromptRestoreAt: number | null = null;

function showMainWindow(opts: { bypassAttention?: boolean } = {}) {
  if (lifecycle.isQuitting()) return;

  // A prompt outranks the main window — but only while it can actually be
  // answered. The rule for deciding that lives in promptReachability, which
  // explains why it has to be behavioural rather than observed.
  if (!opts.bypassAttention) {
    const attention = getTrackingAttentionCoordinator();
    // Device clock is correct here: both readings are clicks by the same
    // person on this machine, so the two are always in the same frame.
    const now = Date.now();
    const decision = decidePromptGate({
      hasPrompt: attention.get().kind !== 'NONE',
      sinceLastRestoreMs: lastPromptRestoreAt === null ? null : now - lastPromptRestoreAt,
      windowMs: PROMPT_UNREACHABLE_WINDOW_MS,
    });
    if (decision === 'restore-prompt') {
      lastPromptRestoreAt = now;
      attention.restoreActive();
      return;
    }
    if (decision === 'release-and-show') {
      lastPromptRestoreAt = null;
      attention.releaseUnreachable('main_window_requested_twice');
    }
  }
  const win = ensureMainWindow({ startHidden: true });
  hidePopover();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Main-window renderer crashes in the last minute; past the limit we stop recreating. */
const mainRendererCrashes: number[] = [];
const MAIN_RENDERER_CRASH_LIMIT = 3;

/**
 * A crashed renderer used to leave a blank window that stayed blank until the
 * app restarted — or, for the floating bar, an invisible always-on-top husk.
 * The main window is rebuilt in place (and shown again if it was showing); any
 * other window is destroyed, and its owner recreates it on next use (the
 * floating bar on the next tick, the popover on the next tray click).
 */
function handleRenderProcessGone(contents: WebContents, details: RenderProcessGoneDetails): void {
  const win = BrowserWindow.fromWebContents(contents);
  const isMain = !!win && win === mainWindow;
  log.error('renderer process gone', {
    reason: details.reason,
    exitCode: details.exitCode,
    window: isMain ? 'main' : 'other',
  });
  if (lifecycle.isQuitting() || details.reason === 'clean-exit' || !win || win.isDestroyed()) return;
  if (!isMain) {
    win.destroy();
    return;
  }
  const now = Date.now();
  while (mainRendererCrashes.length && now - mainRendererCrashes[0]! > 60_000) mainRendererCrashes.shift();
  mainRendererCrashes.push(now);
  const wasVisible = win.isVisible();
  mainWindow = null;
  win.destroy();
  if (mainRendererCrashes.length > MAIN_RENDERER_CRASH_LIMIT) {
    // Crash loop: leave it closed; the tray (or a click) recreates it on demand.
    log.error('main window renderer keeps crashing; not recreating it automatically');
    return;
  }
  const next = ensureMainWindow({ startHidden: !wasVisible });
  if (wasVisible) next.show();
}

function showSettingsWindow() {
  showMainWindow({ bypassAttention: true });
  broadcast('settings:open:push', {});
}

/**
 * Losing the session used to be completely silent: the tray kept ticking, the
 * capture loop kept queueing, and every upload was rejected — one field log ran
 * over six hours that way before anyone noticed. Nothing tracked is lost (both
 * queues are durable and drain after sign-in), but the user has to be told, so
 * surface the login window plus a notification for when that window lands on a
 * Space they are not looking at.
 */
function announceSignOut(): void {
  log.warn('signed out — session ended; prompting for sign-in');
  showMainWindow({ bypassAttention: true });
  showNotification({
    title: 'Timo signed you out',
    body: 'Sign in again to keep your tracked time syncing.',
  }, () => showMainWindow({ bypassAttention: true }));
}

function notifyStartupHealth(state: LaunchAtLoginHealth): void {
  if (!getLaunchAtLoginService().shouldNotifyOnBoot(state)) return;
  const body = state.state === 'NEEDS_INSTALL'
    ? 'Move Timo to Applications so it can start when you sign in.'
    : state.state === 'NEEDS_APPROVAL'
      ? 'Approve Timo in Login Items so it can start when you sign in.'
      : 'Open Timo Settings to repair Launch at Login.';
  showNotification({ title: 'Timo startup needs attention', body }, showSettingsWindow);
}

/** Single 1s heartbeat: tray ticker + floating-bar visibility + live broadcast
 *  + a throttled durable liveness tick (crash-recovery bound). */
function startTick(): void {
  let tick = 0;
  const LIVENESS_EVERY_TICKS = 15; // persist "proof of life" ~every 15s
  let lastTimerState: string | null = null;
  setInterval(() => {
    try {
      tick += 1;
      // One status() per tick: it reconciles the day's ledger, which is the
      // expensive part of this loop.
      const s = getTimerService().status();
      // Installability only depends on whether a timer is open, so only a
      // change of state can change it.
      if (s.state !== lastTimerState) {
        lastTimerState = s.state;
        refreshUpdateInstallability();
      }
      const running = s.state === 'RUNNING';
      const accruing = running && !s.paused;
      // Gate clock corrections on an open entry, not on accrual: stepping the
      // clock between two segments of the SAME entry would leave the entry
      // straddling two frames and could invert a segment boundary.
      setServerClockTrackingActive(running);
      setActivityRecording(accruing, running ? s.entryId : null);
      if (tray) setTrayTitle(tray, running ? fmtShort(s.workedMs) : '');
      syncFloatingBar(s);
      // A hidden main window has nothing to repaint; it reads status afresh
      // the next second it is shown. Every state change is still pushed to
      // it by the command that caused it.
      if (running) broadcast('timer:status:push', s, { skipIfHidden: mainWindow });
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
}

/**
 * The boot reconcile of the login item, with its two (independent) outcomes
 * logged. Throws only if the service itself does; the caller guards it.
 */
function reconcileLaunchAtLoginOnBoot(service: ReturnType<typeof createLaunchAtLoginService>): LaunchAtLoginHealth {
  const launchAtLoginBefore = service.inspect();
  const launchAtLogin = service.reconcileOnBoot();
  // The two outcomes of the boot reconcile are logged separately: they are not
  // alternatives, and either can happen on a given boot.
  if (!launchAtLoginBefore.ready && launchAtLogin.ready) {
    // Boot reconcile deliberately re-enables a disabled login item: startup is a
    // deployment requirement for this IT-deployed tracker, and field Windows
    // machines kept losing it to cleanup tools. But it can also be overriding a
    // user's own Task Manager choice, so record it rather than changing startup
    // behaviour silently.
    log.info('launch at login re-enabled on boot', {
      previousState: launchAtLoginBefore.state,
      previousRemediation: launchAtLoginBefore.remediation,
    });
  }
  if (!launchAtLogin.ready && launchAtLogin.required) {
    // Field-diagnosable startup failures: capture the OS's own view of the
    // login items (registry Run/StartupApproved on Windows, SMAppService on
    // macOS) so a "doesn't start at login" report is solvable from this log.
    try {
      const raw = app.getLoginItemSettings();
      log.warn('launch at login unhealthy after boot reconcile', {
        state: launchAtLogin.state,
        remediation: launchAtLogin.remediation,
        openAtLogin: raw.openAtLogin,
        executableWillLaunchAtLogin: raw.executableWillLaunchAtLogin,
        launchItems: raw.launchItems,
      });
    } catch (err) {
      log.warn('launch at login unhealthy after boot reconcile', {
        state: launchAtLogin.state,
        remediation: launchAtLogin.remediation,
        err: String(err),
      });
    }
  }
  return launchAtLogin;
}

/** One pre-UI boot step; see bootGuard for why each is isolated. */
function bootStep<T>(name: string, run: () => T): T | undefined {
  return guardBootStep(log, name, run);
}

app.whenReady().then(async () => {
  // Before any window exists, so the stray Windows menu bar never paints.
  bootStep('application menu', () => installApplicationMenu(process.platform, {
    appName: app.getName(),
    onQuit: quitFromAppMenu,
  }));
  // Timo has a Dock icon, a main window, and normal Cmd+Tab behavior. Overlay
  // setup must never leave the whole app in macOS's UIElement utility mode.
  bootStep('regular mac application', () => ensureRegularMacApplication());

  // Recover a session stranded by a prior app identity (Grind->Timo) BEFORE any
  // token read. Windows-only: that's where the productName-based userData dir
  // moved and orphaned tokens.bin.
  if (process.platform === 'win32') bootStep('legacy user data migration', () => migrateLegacyUserData());

  // Boot diagnostics — the first line in every log file. Pinpoints the two
  // known Windows failure modes at a glance: a moved data dir (userData /
  // appName after the rebrand) and an unregistered deep-link scheme
  // (protocolRegistered / isDefaultProtocolClient false ⇒ Lark login can't
  // complete). Also confirms the baked API_URL/scheme and token encryption.
  bootStep('boot diagnostics', () => log.info('boot diagnostics', {
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
  }));
  bootStep('crash logging', () => registerChildProcessCrashLogging());

  // The tray first: it is the control a person falls back on when a window has
  // gone missing, and with it up Timo can always be reopened.
  tray = bootStep('tray', () => createTray({
    onToggle: (bounds) => {
      // The tray popover is never gated. Refusing it was how an unreachable
      // prompt turned into "nothing in the whole app opens" — the one control
      // a person falls back on when a window has gone missing must always
      // respond. A genuinely on-top prompt still outranks the popover by
      // window level, so both can be up without conflict.
      getTrackingAttentionCoordinator().restoreActive();
      togglePopover(bounds);
    },
    onOpenMain: () => showMainWindow(),
    onQuit: () => lifecycle.quit('tray'),
    onInstallUpdate: () => void installUpdateNow(),
    getUpdateStatus: () => getUpdateStatus(),
  })) ?? null;

  const launchAtLoginService = bootStep('launch at login service', () => getLaunchAtLoginService());
  const openedAtLogin = (launchAtLoginService && bootStep('hidden launch check', () => launchAtLoginService.shouldStartHidden()))
    ?? isHiddenLaunch(process.argv);
  const launchAtLogin = (launchAtLoginService
    && bootStep('launch at login reconcile', () => reconcileLaunchAtLoginOnBoot(launchAtLoginService))) || null;

  mainWindow = bootStep('main window', () => ensureMainWindow({ startHidden: openedAtLogin })) ?? null;
  if (uiBootOutcome({ hasTray: !!tray, hasWindow: !!mainWindow }) === 'exit') {
    log.error('boot: neither the tray nor the main window could be built; exiting so Timo can start again');
    await lifecycle.exitAfterFailedBoot('no-ui');
    return;
  }
  // Everything below runs in this same tick, so a second launch can never see
  // the UI before IPC and the update service are registered.
  uiReady = true;
  bootStep('quit handlers', () => lifecycle.registerQuitHandlers());
  bootStep('windows session end', () => watchWindowsSessionEnd());
  bootStep('lark connection handler', () => setLarkConnectionHandler(() => showMainWindow()));
  bootStep('ipc', () => registerIpc({
    onOpenMainWindow: () => showMainWindow(),
    onDismissFloatingBar: () => dismissFloatingBar(),
  }));
  bootStep('workspace time listener', () => onWorkspaceTimeChange((context) => {
    broadcast('workspaceTime:push', context);
    if (context.ready) void refreshTodayLedger('config');
  }));
  bootStep('update service', () => startUpdateService({
    showMainWindow: () => showMainWindow(),
    isMainWindowVisible: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(),
  }));
  app.on('render-process-gone', (_event, contents, details) => handleRenderProcessGone(contents, details));
  if (showMainWhenReady) {
    showMainWhenReady = false;
    showMainWindow();
  }

  const attention = getTrackingAttentionCoordinator();
  // Idle detection optionally warns first, then performs the same durable pause
  // at the real idle boundary. Both stages share the single attention window.
  const idleMonitor = new IdleMonitor({
    onWarning: ({ idleStartedAt, deadlineAt }) =>
      attention.requestIdleWarning({ idleStartedAt, deadlineAt }),
    onWarningCancelled: () => {
      attention.clearIdleWarning();
    },
    onIdlePause: async (idleStartedAt) => {
      // The monitor tracks idle on the device clock; the timer runs on the
      // server-aligned clock. Hand over elapsed time, which means the same
      // thing on both, rather than an instant, which does not.
      await getTimerService().pauseForIdle(Math.max(0, Date.now() - idleStartedAt));
      broadcast('timer:status:push', getTimerService().status());
      sendHeartbeatNow();
    },
    onIdlePrompt: (idleStartedAt) => attention.requestIdle(idleStartedAt),
  });
  // However an idle prompt goes away — answered, replaced by a permission
  // prompt, released as unreachable, cleared by a timer command — the monitor
  // has to hear about it, or idle detection stays off for the rest of the run.
  attention.onChange((next, previous) => {
    const wasIdle = previous.kind === 'IDLE' || previous.kind === 'IDLE_WARNING';
    const isIdle = next.kind === 'IDLE' || next.kind === 'IDLE_WARNING';
    if (wasIdle && !isIdle) idleMonitor.resolve();
  });
  idleMonitor.start();
  onTrackedInputActivity(() => idleMonitor.noteActivity());

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
      // Covers a held prompt too: the shared keeper re-raises it every second,
      // and this refreshes the all-Spaces flags the keeper does not touch.
      reassertAllOverlays();
      checkTrackingPermissionsNow();
      // Re-anchor BEFORE pushing anything. The server-aligned clock is driven by
      // a monotonic source, and a monotonic source does not advance while the
      // machine is asleep — so on wake it is behind by the whole sleep, and it
      // stays behind until a heartbeat lands. Draining first would upload
      // entries stamped from a clock we already know is wrong. Catch up from
      // the wall clock right away too: the heartbeat may not land before the
      // user resumes. The away handler already closed any running entry.
      setServerClockTrackingActive(getTimerService().isRunning());
      noteSystemResumed();
      sendHeartbeatNow();
      void drainTimerSyncNow('wake');
      void refreshTodayLedger('wake');
      void drainActivityNow('wake');
    },
    // `resume` can arrive while macOS still owns the lock screen, where the
    // collection behaviours do not stick. Refresh once more on the distinct
    // unlock signal, without re-running timer recovery.
    onVisibilityReturn: () => reassertAllOverlays(),
    // Returned from a lock/sleep that stopped a running timer → offer to resume.
    onReturnFromAway: (info) => {
      if (attention.isPermissionActive()) offerPermissionStart(info.larkTaskGuid);
      else attention.requestAway(info);
    },
    onReturnComplete: () => idleMonitor.resume(),
  });

  // When monitors change (unplug / resolution switch): re-float all overlays
  // and re-home every visible surface onto a display that still exists.
  const onDisplaysChanged = () => {
    reclampFloatingBar();
    attention.placeOnScreen();
    placeReadyToWorkOnScreen();
    reassertAllOverlays();
  };
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);
  screen.on('display-added', onDisplaysChanged);

  onAgentConfigChange(({ previous, current }) => {
    applyActivityCapturePolicy(current);
    applyTodayLedgerMode(current.todayLedgerMode);
    if (!previous || previous.screenshotIntervalSec !== current.screenshotIntervalSec) {
      rescheduleCaptureLoop('agent-config');
    }
  });

  // Shift monitor — fetches the user's assigned shift and fires the
  // "Ready to work?" toast at start time (+ 5-min nudges until buffer
  // expiry). Started in the online boot phase; its IPC is live right away.
  const shiftMonitor = new ShiftMonitor(() => showMainWindow());
  // Sign-in follow-up. The sign-in itself (services/signIn) has already bound
  // the timer, refreshed the agent config, and started the heartbeat.
  onAuthChange((status, info) => {
    if (status === 'loggedIn') {
      void shiftMonitor.refreshShift();
      void drainActivityNow('auth');
      void offerPermissionSetupOnStartup();
    } else {
      clearWorkspaceTimeSession();
      resetPermissionSetupOffer();
      shiftMonitor.clearShift();
      // Pressing Sign out is not news; only a session the server ended is.
      if (info.reason !== 'manual') announceSignOut();
    }
  });
  ipcMain.handle('shift:promptReason', () => readyToWorkReason());
  ipcMain.handle('shift:decide', (_e, decision: 'yes' | 'not_yet') => {
    shiftMonitor.onUserDecision(decision);
  });
  ipcMain.handle('shift:today', async () => {
    await shiftMonitor.refreshShift();
    return shiftMonitor.todayWindow();
  });

  // See boot.ts for why the order is what it is.
  await runBoot({
    // A validated on-disk timezone is available immediately offline; the
    // online config refresh upgrades it to the current server value.
    initializeWorkspaceTime,
    initTimerOnBoot,
    startTimerSyncDrain,
    startTick,
    startLocalServices: () => {
      startCaptureLoop();
      startActivityCapture();
      startTrackingPermissionMonitor();
      startActivitySyncDrain();
      startActiveWindowPolling();
    },
    onLocalReady: () => {
      // Deep links wait for the timer to be bound to the stored owner, so a
      // sign-in callback can never race boot recovery. Flush anything queued
      // during boot (macOS open-url) and a cold-start argv link (Windows/Linux).
      flushQueuedDeepLink();
      const coldStartLink = deepLinkFromArgv(process.argv);
      if (coldStartLink) void handleDeepLink(coldStartLink);
      log.info('agent ready', {
        platform: process.platform,
        version: app.getVersion(),
        openedAtLogin,
        launchAtLoginStatus: launchAtLogin?.state ?? null,
      });
      if (launchAtLogin) notifyStartupHealth(launchAtLogin);
    },
    refreshAgentConfig,
    drainBacklogs: () => {
      // Backlogs drain in the background, never awaited: one request per
      // pending entry used to hold the whole launch.
      void drainTimerSyncNow('boot');
      void refreshTodayLedger('boot');
      void drainActivityNow('boot');
    },
    // A stored session is enough to start: the heartbeat itself validates it,
    // and a dead one signs out through the auth listener. Boot used to make
    // three /auth/me round-trips to learn the same thing.
    hasStoredSession: async () => (await loadTokens()) !== null,
    startHeartbeat,
    offerPermissionSetup: () => void offerPermissionSetupOnStartup({ openedAtLogin }),
    startShiftMonitor: () => shiftMonitor.start(),
    log,
  });
}).catch(async (err: unknown) => {
  log.error('boot failed', { err: String(err), stack: err instanceof Error ? err.stack ?? null : null });
  // Without any UI this process only holds the single-instance lock; let go
  // of it so the next launch can start properly.
  if (!uiReady) await lifecycle.exitAfterFailedBoot('boot-threw');
});

app.on('window-all-closed', () => {
  // Stay alive in the tray.
});
// On Windows/Linux the deep-link arrives as argv of a second launch.
app.on('second-instance', (_e, argv) => {
  const url = deepLinkFromArgv(argv);
  // Queued by deepLink until boot has bound the timer.
  if (url) void handleDeepLink(url);
  if (isHiddenLaunch(argv)) return;
  // A second launch during boot (double-clicking the icon while the first is
  // still starting) used to reach for a window and attention coordinator that
  // did not exist yet. Remember the request; boot shows the window once ready.
  if (!uiReady) {
    showMainWhenReady = true;
    return;
  }
  showMainWindow();
});

void tray;
