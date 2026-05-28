import { BrowserWindow, screen, type Rectangle } from 'electron';
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
    width: 300,
    height: 340,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    hasShadow: true,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.cjs'),
    },
  });
  load(win, 'popover');
  win.on('blur', () => win?.hide());
  return win;
}

/** Toggle the popover anchored under the tray icon. */
export function togglePopover(trayBounds: Rectangle): void {
  const w = ensure();
  if (w.isVisible()) {
    w.hide();
    return;
  }
  const { workArea } = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const pw = w.getBounds().width;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - pw / 2);
  x = Math.max(workArea.x + 6, Math.min(x, workArea.x + workArea.width - pw - 6));
  const y = Math.round(trayBounds.y + trayBounds.height + 6);
  w.setPosition(x, y, false);
  w.show();
  w.focus();
}

export function hidePopover(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}
