import { BrowserWindow } from 'electron';
import path from 'node:path';
import { mainWindowBackground } from './services/appearance';

/**
 * The main application window: a real, resizable macOS window with a
 * hidden-inset title bar (native traffic lights over our custom toolbar) and
 * sidebar vibrancy. The content pane paints solid white over the material so
 * only the sidebar shows the frosted-glass effect (the System Settings look).
 */
export function createMainWindow(opts: { startHidden?: boolean } = {}): BrowserWindow {
  const preloadPath = path.join(__dirname, '../preload/index.cjs');

  const win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 460,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    // Solid background (no vibrancy) in the chosen theme, so the window never
    // flashes the other colour before the page paints.
    backgroundColor: mainWindowBackground(),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.once('ready-to-show', () => {
    if (!opts.startHidden) win.show();
  });

  return win;
}
