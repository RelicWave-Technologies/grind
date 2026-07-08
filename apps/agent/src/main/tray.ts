import { Tray, Menu, nativeImage, app, type MenuItemConstructorOptions, type Rectangle } from 'electron';
import path from 'node:path';
import { log } from './logger';
import type { UpdateStatus } from './services/updates/state';
import { trayMenuTitleForElapsed, trayTooltipForElapsed } from './trayPresentation';

const ICONS_DIR = 'build/icons';
const TRAY_GUID = 'com.relicwave.grind.tray';
const trayLabels = new WeakMap<Tray, string>();
const trayIconLoaded = new WeakMap<Tray, boolean>();

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function trayIconCandidates(filename: string): string[] {
  return uniquePaths([
    path.join(app.getAppPath(), ICONS_DIR, filename),
    path.join(process.resourcesPath, 'app', ICONS_DIR, filename),
    path.join(__dirname, '../../build/icons', filename),
    path.join(process.cwd(), ICONS_DIR, filename),
  ]);
}

function trayImage(): { image: Electron.NativeImage; loaded: boolean } {
  const filename = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const candidates = trayIconCandidates(filename);

  for (const candidate of candidates) {
    try {
      const img = nativeImage.createFromPath(candidate);
      if (img.isEmpty()) continue;
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return { image: img, loaded: true };
    } catch (err) {
      log.warn('tray icon candidate load failed', { candidate, err: String(err) });
    }
  }

  log.warn('tray icon load failed', { filename, candidates });
  return { image: nativeImage.createEmpty(), loaded: false };
}

/** Menu-bar item. Left-click toggles the popover; right-click shows a menu. */
export function createTray(opts: {
  onToggle: (bounds: Rectangle) => void;
  onOpenMain: () => void;
  onInstallUpdate?: () => void;
  getUpdateStatus?: () => UpdateStatus;
}): Tray {
  const icon = trayImage();
  const tray = new Tray(icon.image, TRAY_GUID);
  trayIconLoaded.set(tray, icon.loaded);
  setTrayTitle(tray, '');

  tray.on('click', (_e, bounds) => opts.onToggle(bounds));
  tray.on('right-click', () => {
    const template: MenuItemConstructorOptions[] = [
      { label: 'Open Timo', click: opts.onOpenMain },
    ];
    const update = opts.getUpdateStatus?.();
    if (update?.phase === 'ready') {
      template.push({
        label: update.canInstallNow ? 'Restart to update Timo' : 'Update ready after tracking stops',
        enabled: update.canInstallNow,
        click: () => opts.onInstallUpdate?.(),
      });
    }
    template.push(
      { type: 'separator' },
      { label: 'Quit Timo', click: () => app.quit() },
    );
    const menu = Menu.buildFromTemplate(template);
    tray.popUpContextMenu(menu);
  });

  return tray;
}

/** Live elapsed-time string next to the menu-bar icon (macOS). */
export function setTrayTitle(tray: Tray, text: string): void {
  const title = trayMenuTitleForElapsed(text, { hasIcon: trayIconLoaded.get(tray) ?? true });
  const tooltip = trayTooltipForElapsed(text);
  const label = `${title}\n${tooltip}`;
  if (trayLabels.get(tray) === label) return;
  trayLabels.set(tray, label);
  tray.setToolTip(tooltip);
  if (process.platform === 'darwin') tray.setTitle(title);
}
