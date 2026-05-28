import { app, BrowserWindow, Tray } from 'electron';
import { createTray, setTrayTitle } from './tray';
import { createMainWindow } from './window';
import { registerIpc } from './ipc';
import { startHeartbeatIfAuthed } from './services/heartbeat';
import { getTimerService, initTimerOnBoot } from './services/timer';
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
  mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(async () => {
  mainWindow = createMainWindow();
  tray = createTray({ onToggle: () => toggleMainWindow() });
  registerIpc({ trayWindow: mainWindow });

  // Close button hides to tray; real quit only via ⌘Q / tray menu.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  // Re-open on dock click (macOS).
  app.on('activate', () => showMainWindow());

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

  // Live menu-bar ticker while tracking.
  setInterval(() => {
    if (!tray) return;
    try {
      const s = getTimerService().status();
      setTrayTitle(tray, s.state === 'RUNNING' ? fmtShort(s.workedMs) : '');
    } catch {
      /* timer not ready yet */
    }
  }, 1000);

  log.info('agent ready', { platform: process.platform, version: app.getVersion() });
});

function toggleMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showMainWindow();
}

app.on('window-all-closed', () => {
  // Stay alive in the tray; do not quit on window close.
});

app.on('second-instance', () => showMainWindow());

void tray;
