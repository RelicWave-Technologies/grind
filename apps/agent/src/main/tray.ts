import { Tray, Menu, nativeImage, app, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import path from 'node:path';
import { log } from './logger';
import type { UpdateStatus } from './services/updates/state';

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

/** Menu-bar item. Left-click toggles the popover; right-click shows a menu. */
export function createTray(opts: {
  onToggle: (bounds: Rectangle) => void;
  onOpenMain: () => void;
  onInstallUpdate?: () => void;
  getUpdateStatus?: () => UpdateStatus;
}): Tray {
  const tray = new Tray(trayImage());
  tray.setToolTip('Grind');

  tray.on('click', (_e, bounds) => opts.onToggle(bounds));
  tray.on('right-click', () => {
    const template: MenuItemConstructorOptions[] = [
      { label: 'Open Grind', click: opts.onOpenMain },
    ];
    const update = opts.getUpdateStatus?.();
    if (update?.phase === 'ready') {
      template.push({
        label: update.canInstallNow ? 'Restart to update Grind' : 'Update ready after tracking stops',
        enabled: update.canInstallNow,
        click: () => opts.onInstallUpdate?.(),
      });
    }
    template.push(
      { type: 'separator' },
      { label: 'Quit Grind', click: () => app.quit() },
    );
    const menu = Menu.buildFromTemplate(template);
    tray.popUpContextMenu(menu);
  });

  return tray;
}

/** Live elapsed-time string next to the menu-bar icon (macOS). */
export function setTrayTitle(tray: Tray, text: string): void {
  if (process.platform === 'darwin') tray.setTitle(text ? ` ${text}` : '');
}
