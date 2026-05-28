import { Tray, Menu, nativeImage, type BrowserWindow, app, screen } from 'electron';
import path from 'node:path';
import { log } from './logger';

function trayIconPath(): string {
  const filename =
    process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  // In dev, electron-vite serves out/main and we resolve relative to __dirname.
  // The icon lives under apps/agent/build/icons at build time.
  return path.join(__dirname, '../../build/icons', filename);
}

function emptyIcon(): Electron.NativeImage {
  // Fallback: 16x16 transparent template image so the tray slot always renders.
  const img = nativeImage.createEmpty();
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

export function createTray(win: BrowserWindow): Tray {
  let image: Electron.NativeImage;
  try {
    image = nativeImage.createFromPath(trayIconPath());
    if (image.isEmpty()) image = emptyIcon();
    else if (process.platform === 'darwin') image.setTemplateImage(true);
  } catch (err) {
    log.warn('tray icon load failed; using fallback', { err: String(err) });
    image = emptyIcon();
  }

  const tray = new Tray(image);
  tray.setToolTip('Grind Tracker');

  const showWindow = () => {
    const trayBounds = tray.getBounds();
    const winBounds = win.getBounds();
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
    let y =
      process.platform === 'darwin'
        ? Math.round(trayBounds.y + trayBounds.height + 4)
        : Math.round(trayBounds.y - winBounds.height - 4);
    // clamp inside the display
    x = Math.max(display.workArea.x, Math.min(x, display.workArea.x + display.workArea.width - winBounds.width));
    y = Math.max(display.workArea.y, Math.min(y, display.workArea.y + display.workArea.height - winBounds.height));
    win.setPosition(x, y, false);
    win.show();
    win.focus();
  };

  tray.on('click', () => (win.isVisible() ? win.hide() : showWindow()));
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open Grind', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    tray.popUpContextMenu(menu);
  });

  return tray;
}
