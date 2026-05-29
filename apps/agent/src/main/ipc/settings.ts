import { ipcMain, app, shell } from 'electron';
import { screenStatus, hasAccessibilityAccess } from '../services/permissions';
import { isActivityCapturing } from '../services/activity';

export interface SettingsInfo {
  version: string;
  platform: string;
  launchAtLogin: boolean;
  screenStatus: string;
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', (): SettingsInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    screenStatus: screenStatus(),
  }));

  ipcMain.handle('settings:setLaunchAtLogin', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    return app.getLoginItemSettings().openAtLogin;
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

  // Relaunch — required for a Screen Recording grant to take effect.
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });
}
