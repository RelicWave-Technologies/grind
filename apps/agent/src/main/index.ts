import { app, BrowserWindow, Tray } from 'electron';
import { createTray } from './tray';
import { createTrayWindow } from './window';
import { registerIpc } from './ipc';
import { startHeartbeatIfAuthed } from './services/heartbeat';
import { initTimerOnBoot } from './services/timer';
import { log } from './logger';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let tray: Tray | null = null;
let trayWindow: BrowserWindow | null = null;

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();

  trayWindow = createTrayWindow();
  tray = createTray(trayWindow);
  registerIpc({ trayWindow });

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

  log.info('agent ready', { platform: process.platform, version: app.getVersion() });
});

app.on('window-all-closed', () => {
  // intentionally no-op: tray app stays alive when the popup window closes
});

app.on('second-instance', () => {
  if (trayWindow) {
    trayWindow.show();
    trayWindow.focus();
  }
});

// keep tray reference alive
void tray;
