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
    width: 248,
    height: 56,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    hasShadow: true,
    // 'panel' floats above fullscreen apps without stealing focus (macOS).
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.cjs'),
    },
  });
  load(win, 'floating');
  reassertFloating();
  return win;
}

/** Keep it above everything, including fullscreen apps and across Spaces. */
export function reassertFloating(): void {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

export function showFloatingBar(): void {
  const w = ensure();
  const { workArea } = screen.getPrimaryDisplay();
  const b = w.getBounds();
  w.setPosition(
    workArea.x + workArea.width - b.width - 20,
    workArea.y + workArea.height - b.height - 20,
    false,
  );
  if (!w.isVisible()) w.showInactive();
  reassertFloating();
}

export function hideFloatingBar(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}
