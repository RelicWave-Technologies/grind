import { ipcMain, app, shell, dialog } from 'electron';
import { hasAccessibilityAccess } from '../services/permissions';
import { getPreferences } from '../services/preferences';
import { getLaunchAtLoginService } from '../services/launchAtLogin';
import { applyFloatingBarVisibility, resetFloatingBarPosition } from '../floating';
import { getAppLifecycle } from '../appLifecycle';
import { getTimerService } from '../services/timer';
import { moveToApplications } from '../services/moveToApplications';
import { getPermissionRelaunchMemory } from '../services/permissionRelaunch';
import { getTrackingReadinessService } from '../services/trackingReadiness';
import type { LaunchAtLoginHealth, MoveToApplicationsResult } from '../../shared/launchAtLogin';

interface SettingsInfo {
  version: string;
  platform: string;
  launchAtLogin: LaunchAtLoginHealth;
  /** Per-device UI pref (M2 floating bar). */
  floatingBarVisible: boolean;
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', (): SettingsInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    launchAtLogin: getLaunchAtLoginService().inspect(),
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
      cleanup: () => getAppLifecycle().prepareExit('quit'),
      invalidateCleanup: () => getAppLifecycle().abortExit('move-to-applications'),
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

  // A permission restart from the last couple of minutes, if it was pressed
  // just before this process started. The UI compares it with the live verdict.
  ipcMain.handle('app:permissionRelaunch', () => getPermissionRelaunchMemory().forThisBoot());

  ipcMain.handle('settings:openStartupPrefs', async () => {
    const url = getLaunchAtLoginService().startupSettingsUrl();
    if (url) await shell.openExternal(url);
  });

  // Prompt the system to add this app to the Accessibility list, then deep-link.
  ipcMain.handle('permissions:requestAccessibility', async () => {
    hasAccessibilityAccess(true); // shows the macOS prompt / registers the app
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  });

  // Permission restart — the fallback once Check again did not help. The
  // verdict it was pressed for is recorded first, so the next boot can tell a
  // restart that did not help and offer the remove-and-re-add guidance instead
  // of another restart. Under `electron-vite dev`, app.relaunch() spawns
  // Electron without the Vite dev-server URL → a blank window, so we instead
  // tell the developer to restart the dev process.
  ipcMain.handle('app:relaunch', async () => {
    if (app.isPackaged) {
      try {
        const { readiness } = await getTrackingReadinessService().inspect();
        getPermissionRelaunchMemory().remember(readiness);
      } catch {
        // Only the loop breaker is lost; the restart itself still happens.
      }
      await getAppLifecycle().relaunch('permission');
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
