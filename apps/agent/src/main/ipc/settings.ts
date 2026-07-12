import { ipcMain, app, shell, dialog } from 'electron';
import { screenStatus, hasAccessibilityAccess } from '../services/permissions';
import { getActivityCaptureStatus, type ActivityCaptureStatus } from '../services/activity';
import { getPreferences } from '../services/preferences';
import { getLaunchAtLoginService } from '../services/launchAtLogin';
import { applyFloatingBarVisibility, resetFloatingBarPosition } from '../floating';
import { invalidateQuitCleanup, runQuitCleanup } from '../services/quitCleanup';
import { getTimerService } from '../services/timer';
import { moveToApplications } from '../services/moveToApplications';
import type { LaunchAtLoginHealth, MoveToApplicationsResult } from '../../shared/launchAtLogin';

export interface SettingsInfo {
  version: string;
  platform: string;
  launchAtLogin: LaunchAtLoginHealth;
  screenStatus: string;
  /** Per-device UI pref (M2 floating bar). */
  floatingBarVisible: boolean;
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', (): SettingsInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    launchAtLogin: getLaunchAtLoginService().inspect(),
    screenStatus: screenStatus(),
    floatingBarVisible: getPreferences().floatingBar.visible,
  }));

  ipcMain.handle('settings:repairLaunchAtLogin', (): LaunchAtLoginHealth => {
    return getLaunchAtLoginService().repair();
  });

  ipcMain.handle('settings:moveToApplications', async (): Promise<MoveToApplicationsResult> => {
    return moveToApplications({
      isTracking: () => getTimerService().status().state === 'RUNNING',
      confirm: async () => {
        const confirmation = await dialog.showMessageBox({
          type: 'question',
          message: 'Move Timo to Applications?',
          detail: 'Timo will relaunch from Applications and can then start automatically when you sign in.',
          buttons: ['Move to Applications', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
        return confirmation.response === 0;
      },
      cleanup: () => runQuitCleanup('quit'),
      invalidateCleanup: invalidateQuitCleanup,
      move: () => getLaunchAtLoginService().moveToApplicationsFolder({
        conflictHandler: (conflictType) => {
          const useExisting = conflictType === 'existsAndRunning';
          const response = dialog.showMessageBoxSync({
            type: 'question',
            message: useExisting ? 'Timo is already running from Applications' : 'Timo already exists in Applications',
            detail: useExisting
              ? 'Use the installed Timo and close this copy?'
              : 'Replace the installed copy with this version?',
            buttons: [useExisting ? 'Use Installed Timo' : 'Replace', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
          });
          return response === 0;
        },
      }),
    });
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

  ipcMain.handle('settings:openStartupPrefs', async () => {
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
    } else if (process.platform === 'win32') {
      await shell.openExternal('ms-settings:startupapps');
    }
  });

  // Accessibility (global keyboard/mouse counting via uiohook).
  ipcMain.handle('permissions:accessibility', (): ActivityCaptureStatus => getActivityCaptureStatus());

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
      await runQuitCleanup('quit');
      app.relaunch();
      app.exit(0);
      return;
    }
    await dialog.showMessageBox({
      type: 'info',
      message: 'Restart needed (dev mode)',
      detail: 'Auto-restart is disabled in dev because it can’t reconnect to the Vite dev server. Quit Timo and run `pnpm --filter @grind/agent dev` again to apply the change.',
      buttons: ['OK'],
    });
  });
}
