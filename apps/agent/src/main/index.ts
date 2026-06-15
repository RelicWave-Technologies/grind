import { app, BrowserWindow, Tray, ipcMain, screen } from 'electron';
import { createTray, setTrayTitle } from './tray';
import { createMainWindow } from './window';
import { registerIpc } from './ipc';
import { startHeartbeatIfAuthed } from './services/heartbeat';
import { getTimerService, initTimerOnBoot } from './services/timer';
import { startCaptureLoop } from './services/capture';
import { startActivityCapture, setActivityRecording, flushPartialActivity } from './services/activity';
import { startActiveWindowPolling } from './services/activity/windowPoller';
import { registerPowerEvents } from './services/power';
import { IdleMonitor } from './services/idle/monitor';
import { showFloatingBar, hideFloatingBar, reclampFloatingBar } from './floating';
import { reassertAllOverlays } from './windows/overlay';
import { flushPreferences } from './services/preferences';
import { togglePopover, hidePopover } from './popover';
import { showIdlePrompt, hideIdlePrompt } from './idlePrompt';
import { ShiftMonitor } from './services/shift';
import { onAuthChange } from './services/apiClient';
import { refreshAgentConfig } from './services/agentConfig';
import { registerProtocol, handleDeepLink, deepLinkFromArgv, flushQueuedDeepLink } from './services/deepLink';
import { broadcast } from './broadcast';
import { log } from './logger';

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

// Register grind:// for Lark login. Must happen before whenReady, and the
// macOS open-url handler must be attached early — the OS can deliver the
// deep-link before the app finishes booting (handleDeepLink queues it).
registerProtocol();
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

function ensureAutoStart() {
  // Launch at login by default (internal tool). Start hidden to the tray.
  const settings = app.getLoginItemSettings();
  if (!settings.openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }
}

app.whenReady().then(async () => {
  ensureAutoStart();

  const openedAtLogin =
    process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;

  mainWindow = createMainWindow({ startHidden: openedAtLogin });
  tray = createTray({
    onToggle: (bounds) => togglePopover(bounds),
    onOpenMain: () => showMainWindow(),
  });
  registerIpc({ onOpenMainWindow: () => showMainWindow() });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  app.on('before-quit', () => {
    isQuitting = true;
    flushPartialActivity(); // seal the in-flight minute (durable local insert)
    void flushPreferences(); // persist any pending floating-bar position
  });
  app.on('activate', () => showMainWindow());

  // On wake the OS drops the always-on-top / all-Spaces flags (electron#36364)
  // — re-assert float on EVERY live overlay, not just the bar.
  registerPowerEvents({ onWake: () => reassertAllOverlays() });

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
    showIdlePrompt();
  });
  idleMonitor.start();

  ipcMain.handle('idle:get', () => ({ idleStartedAt: idleMonitor.getIdleStart() }));
  ipcMain.handle('idle:resolve', async (_e, action: 'continue' | 'break') => {
    try {
      if (action === 'continue') await getTimerService().resumeFromIdle(Date.now());
      else await getTimerService().stop();
    } catch (err) {
      log.warn('idle resolve failed', { action, err: String(err) });
    }
    idleMonitor.resolve();
    hideIdlePrompt();
    broadcast('timer:status:push', getTimerService().status());
  });

  try {
    await startHeartbeatIfAuthed();
  } catch (err) {
    log.warn('startHeartbeatIfAuthed failed', { err: String(err) });
  }
  try {
    await initTimerOnBoot();
  } catch (err) {
    log.warn('initTimerOnBoot failed', { err: String(err) });
  }

  // Pull the server-driven capture cadence + idle threshold (per-user →
  // workspace policy) BEFORE the capture loop schedules its first shot, so the
  // first interval already reflects policy. No-ops (keeps defaults) if logged out.
  await refreshAgentConfig();

  startCaptureLoop();
  startActivityCapture();
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

  // Deep-link delivery is now safe. Flush any grind:// URL that arrived during
  // boot (macOS open-url), and pick up a cold-start argv link (Windows/Linux).
  flushQueuedDeepLink();
  const coldStartLink = deepLinkFromArgv(process.argv);
  if (coldStartLink) void handleDeepLink(coldStartLink);

  log.info('agent ready', { platform: process.platform, version: app.getVersion(), openedAtLogin });
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
