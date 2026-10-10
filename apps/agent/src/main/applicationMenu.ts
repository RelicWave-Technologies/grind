import { Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * Electron installs a default File / Edit / View / Window / Help menu whenever
 * an app never sets one of its own.
 *
 * On macOS that menu lives in the system menu bar, where it looks native — and
 * where it is also the only thing providing the standard Cmd+C / Cmd+V /
 * Cmd+A / Cmd+Q accelerators. Removing it there silently breaks copy and paste
 * inside our own text fields, so it has to stay. Its Quit item is replaced,
 * though: a prompt that takes focus (idle, away, permissions) can catch a
 * Cmd+Q meant for the app the person was just typing in, and the stock item
 * quits on the spot — mid-timer. Ours asks first while a timer is running.
 *
 * On Windows and Linux the same menu is drawn INSIDE the window frame, above
 * our toolbar, where it is just a stray bar in a tray app that has no use for
 * it. Those platforms route the standard editing shortcuts through the OS
 * rather than the menu, so dropping it costs nothing.
 *
 * `autoHideMenuBar` is the other option, but it only hides the bar until the
 * user presses Alt. Removing the menu outright is what we actually want.
 */
export function shouldRemoveApplicationMenu(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin';
}

/** The stock macOS menu, minus Help (Electron's links), with our own Quit. */
export function macApplicationMenuTemplate(appName: string, onQuit: () => void): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${appName}`, accelerator: 'Command+Q', click: () => onQuit() },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}

/**
 * Cmd+Q: quit straight away when nothing is being tracked; while a timer is
 * running, ask first. Quits through the same path as the tray's Quit.
 */
export async function quitFromMenu(deps: {
  isTimerRunning: () => boolean;
  confirm: () => Promise<boolean>;
  quit: () => void;
}): Promise<boolean> {
  let running = false;
  try {
    running = deps.isTimerRunning();
  } catch {
    running = false;
  }
  if (running && !(await deps.confirm())) return false;
  deps.quit();
  return true;
}

export function installApplicationMenu(
  platform: NodeJS.Platform = process.platform,
  opts: { appName?: string; onQuit?: () => void } = {},
): void {
  if (shouldRemoveApplicationMenu(platform)) {
    Menu.setApplicationMenu(null);
    return;
  }
  // Without a quit handler there is nothing to replace; keep Electron's menu.
  if (!opts.onQuit) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(macApplicationMenuTemplate(opts.appName ?? 'Timo', opts.onQuit)));
}
