import { ipcMain, app, shell, dialog } from 'electron';
import { screenStatus, hasAccessibilityAccess } from '../services/permissions';
import { isActivityCapturing } from '../services/activity';
import { getPreferences } from '../services/preferences';
import { applyFloatingBarVisibility, resetFloatingBarPosition } from '../floating';

export interface SettingsInfo {
  version: string;
  platform: string;
  launchAtLogin: boolean;
  screenStatus: string;
  /** Per-device UI pref (M2 floating bar). */
  floatingBarVisible: boolean;
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', (): SettingsInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    screenStatus: screenStatus(),
    floatingBarVisible: getPreferences().floatingBar.visible,
  }));

  ipcMain.handle('settings:setLaunchAtLogin', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    return app.getLoginItemSettings().openAtLogin;
  });

  // M2 floating bar: visibility toggle + reset-to-default-corner.
  ipcMain.handle('settings:setFloatingBarVisible', (_e, enabled: boolean): boolean => {
    applyFloatingBarVisibility(!!enabled);
    return getPreferences().floatingBar.visible;
  });
  ipcMain.handle('settings:resetFloatingBarPosition', () => {
    resetFloatingBarPosition();
  });

  ipcMain.handle('settings:openScreenPrefs', async () => {
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
  });

  // Accessibility (global keyboard/mouse counting via uiohook).
  ipcMain.handle('permissions:accessibility', (): { trusted: boolean; capturing: boolean } => ({
    trusted: hasAccessibilityAccess(false),
    capturing: isActivityCapturing(),
  }));

  // Prompt the system to add this app to the Accessibility list, then deep-link.
  ipcMain.handle('permissions:requestAccessibility', async () => {
    hasAccessibilityAccess(true); // shows the macOS prompt / registers the app
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  });

  ipcMain.handle('settings:openDataFolder', async () => {
    await shell.openPath(app.getPath('userData'));
  });

  // Relaunch — required for a permission grant to take effect.
  // In a packaged build this relaunches cleanly. Under `electron-vite dev`,
  // app.relaunch() spawns Electron without the Vite dev-server URL → a blank
  // window, so we instead tell the developer to restart the dev process.
  ipcMain.handle('app:relaunch', async () => {
    if (app.isPackaged) {
      app.relaunch();
      app.exit(0);
      return;
    }
    await dialog.showMessageBox({
      type: 'info',
      message: 'Restart needed (dev mode)',
      detail: 'Auto-restart is disabled in dev because it can’t reconnect to the Vite dev server. Quit Grind and run `pnpm --filter @grind/agent dev` again to apply the change.',
      buttons: ['OK'],
    });
  });
}
