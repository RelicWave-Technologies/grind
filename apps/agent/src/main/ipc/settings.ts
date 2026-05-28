import { ipcMain, app, shell } from 'electron';
import { screenStatus } from '../services/permissions';

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

  ipcMain.handle('settings:openDataFolder', async () => {
    await shell.openPath(app.getPath('userData'));
  });
}
