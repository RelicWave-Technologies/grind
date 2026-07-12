import { ipcMain } from 'electron';
import { hidePermissionPrompt } from '../permissionPrompt';
import {
  clearPendingTrackingCommand,
  getPendingTrackingCommand,
  retryPendingTrackingCommand,
} from '../services/trackingCommands';
import { getTrackingReadinessService } from '../services/trackingReadiness';

export function registerPermissionsIpc(): void {
  ipcMain.handle('permissions:readiness', async () => {
    return (await getTrackingReadinessService().inspect()).readiness;
  });
  ipcMain.handle('permissions:requestScreen', async () => {
    return (await getTrackingReadinessService().requestScreenAccess()).readiness;
  });
  ipcMain.handle('permissions:promptContext', () => getPendingTrackingCommand());
  ipcMain.handle('permissions:retryPending', () => retryPendingTrackingCommand());
  ipcMain.handle('permissions:closePrompt', () => {
    clearPendingTrackingCommand();
    hidePermissionPrompt();
    return { ok: true as const };
  });
}
