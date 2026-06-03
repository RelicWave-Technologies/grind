import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

/**
 * "Ready to work?" toast — small frameless panel that appears at the
 * top-right of the primary display when the user's shift window opens.
 * Renders the `#ready-to-work` route in the renderer.
 *
 * Lifecycle is owned by ShiftMonitor; this module just creates +
 * positions the BrowserWindow.
 */

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
    width: 320,
    height: 168,
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
  load(win, 'ready-to-work');
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // If the user closes via window controls (rare; chrome is hidden), treat
  // as a "Not yet" — the renderer's onbeforeunload should beat us to it.
  win.on('close', () => {
    win = null;
  });
  return win;
}

export function showReadyToWork(): void {
  const w = ensure();
  const { workArea } = screen.getPrimaryDisplay();
  const b = w.getBounds();
  // Top-right with a small gutter.
  w.setPosition(
    Math.round(workArea.x + workArea.width - b.width - 16),
    Math.round(workArea.y + 16),
    false,
  );
  w.show();
  // Don't steal focus aggressively — this is a notification, not a modal.
  w.showInactive();
}

export function hideReadyToWork(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

export function isReadyToWorkVisible(): boolean {
  return !!(win && !win.isDestroyed() && win.isVisible());
}
