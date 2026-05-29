import { app, BrowserWindow, Tray, ipcMain } from 'electron';
import { createTray, setTrayTitle } from './tray';
import { createMainWindow } from './window';
import { registerIpc } from './ipc';
import { startHeartbeatIfAuthed } from './services/heartbeat';
import { getTimerService, initTimerOnBoot } from './services/timer';
import { startCaptureLoop } from './services/capture';
import { startActivityCapture, setActivityRecording } from './services/activity';
import { startMeetingDetection, isInMeeting } from './services/meeting';
import { registerPowerEvents } from './services/power';
import { IdleMonitor } from './services/idle/monitor';
import { showFloatingBar, hideFloatingBar, reassertFloating } from './floating';
import { togglePopover, hidePopover } from './popover';
import { showIdlePrompt, hideIdlePrompt } from './idlePrompt';
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
  });
  app.on('activate', () => showMainWindow());

  registerPowerEvents({ onWake: () => reassertFloating() });

  // Idle detection → pause the timer (idle is never counted) and prompt.
  // Suppressed while in a meeting (present but not typing).
  const idleMonitor = new IdleMonitor(async (idleStartedAt) => {
    try {
      await getTimerService().pauseForIdle(idleStartedAt);
    } catch (err) {
      log.warn('pauseForIdle failed', { err: String(err) });
    }
    broadcast('timer:status:push', getTimerService().status());
    showIdlePrompt();
  }, () => isInMeeting());
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

  startCaptureLoop();
  startActivityCapture();
  startMeetingDetection();

  // Single 1s heartbeat: tray ticker + floating-bar visibility + live broadcast.
  let lastRunning = false;
  setInterval(() => {
    try {
      const s = getTimerService().status();
      const running = s.state === 'RUNNING';
      setActivityRecording(running && !(s.state === 'RUNNING' && s.paused));
      if (tray) setTrayTitle(tray, running ? fmtShort(s.workedMs) : '');
      if (running) showFloatingBar();
      else if (lastRunning) hideFloatingBar();
      lastRunning = running;
      if (running) broadcast('timer:status:push', s);
    } catch {
      /* timer not ready */
    }
  }, 1000);

  log.info('agent ready', { platform: process.platform, version: app.getVersion(), openedAtLogin });
});

app.on('window-all-closed', () => {
  // Stay alive in the tray.
});
app.on('second-instance', () => showMainWindow());

void tray;
