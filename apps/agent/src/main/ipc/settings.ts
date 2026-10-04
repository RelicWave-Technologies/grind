import { ipcMain, app, shell, dialog } from 'electron';
import { screenStatus, hasAccessibilityAccess } from '../services/permissions';
import { getPreferences, rememberPermissionRelaunch } from '../services/preferences';
import { getLaunchAtLoginService } from '../services/launchAtLogin';
import { applyFloatingBarVisibility, resetFloatingBarPosition } from '../floating';
import { invalidateQuitCleanup, runQuitCleanup } from '../services/quitCleanup';
import { getTimerService } from '../services/timer';
import { moveToApplications } from '../services/moveToApplications';
import { getTrackingReadinessService, permissionRelaunchReason } from '../services/trackingReadiness';
import { installUpdateInsteadOfRelaunch } from '../services/updates';
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

  // Input Monitoring is a SEPARATE TCC service from Accessibility
  // (kTCCServiceListenEvent vs kTCCServiceAccessibility). macOS exposes no
  // prompt API for it, so the only thing we can do when the event tap is
  // refused is take the user straight to the right pane.
  ipcMain.handle('settings:openInputMonitoringPrefs', async () => {
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
    }
  });

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

  // Permission restart. The verdict it was pressed for is recorded first, so if
  // the next boot lands on the same verdict the UI stops offering a restart
  // that has already failed once. Under `electron-vite dev`, app.relaunch()
  // spawns Electron without the Vite dev-server URL → a blank window, so we
  // instead tell the developer to restart the dev process.
  ipcMain.handle('app:relaunch', async () => {
    if (app.isPackaged) {
      const { readiness } = await getTrackingReadinessService().inspect();
      if (!readiness.ready) {
        // Device clock: only ever compared with the next boot's device clock.
        rememberPermissionRelaunch({ reason: permissionRelaunchReason(readiness), at: Date.now() });
      }
      await runQuitCleanup('quit');
      if (await installUpdateInsteadOfRelaunch()) return;
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
