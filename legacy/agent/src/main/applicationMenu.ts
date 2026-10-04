import { Menu } from 'electron';

/**
 * Electron installs a default File / Edit / View / Window / Help menu whenever
 * an app never sets one of its own.
 *
 * On macOS that menu lives in the system menu bar, where it looks native — and
 * where it is also the only thing providing the standard Cmd+C / Cmd+V /
 * Cmd+A / Cmd+Q accelerators. Removing it there silently breaks copy and paste
 * inside our own text fields, so it has to stay.
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

export function installApplicationMenu(platform: NodeJS.Platform = process.platform): void {
  if (shouldRemoveApplicationMenu(platform)) Menu.setApplicationMenu(null);
}
