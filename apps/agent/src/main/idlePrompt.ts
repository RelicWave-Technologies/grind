import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

let win: BrowserWindow | null = null;

function load(w: BrowserWindow, hash: string) {
  if (process.env.ELECTRON_RENDERER_URL) {
    void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    void w.loadFile(path.join(__dirname, '../renderer/index.html'), { hash });
  }
}

function ensure(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 340,
    height: 280,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    hasShadow: true,
    alwaysOnTop: true,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.cjs'),
    },
  });
  load(win, 'idle');
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  return win;
}

export function showIdlePrompt(): void {
  const w = ensure();
  const { workArea } = screen.getPrimaryDisplay();
  const b = w.getBounds();
  w.setPosition(
    Math.round(workArea.x + (workArea.width - b.width) / 2),
    Math.round(workArea.y + (workArea.height - b.height) / 3),
    false,
  );
  w.show();
  w.focus();
}

export function hideIdlePrompt(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}
