import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'node:path';
import { log } from './logger';

function trayImage(): Electron.NativeImage {
  const filename = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '../../build/icons', filename));
    if (!img.isEmpty() && process.platform === 'darwin') img.setTemplateImage(true);
    if (!img.isEmpty()) return img;
  } catch (err) {
    log.warn('tray icon load failed', { err: String(err) });
  }
  const empty = nativeImage.createEmpty();
  if (process.platform === 'darwin') empty.setTemplateImage(true);
  return empty;
}

/** Menu-bar item. Click toggles the main window; right-click shows a menu. */
export function createTray(opts: { onToggle: () => void }): Tray {
  const tray = new Tray(trayImage());
  tray.setToolTip('Grind');

  tray.on('click', opts.onToggle);
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open Grind', click: opts.onToggle },
      { type: 'separator' },
      { label: 'Quit Grind', click: () => app.quit() },
    ]);
    tray.popUpContextMenu(menu);
  });

  return tray;
}

/** Show a live elapsed-time string next to the menu-bar icon (macOS). */
export function setTrayTitle(tray: Tray, text: string): void {
  if (process.platform === 'darwin') tray.setTitle(text ? ` ${text}` : '');
}
