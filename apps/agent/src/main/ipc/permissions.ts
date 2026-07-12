import { ipcMain } from 'electron';
import { getTrackingReadinessService } from '../services/trackingReadiness';

export function registerPermissionsIpc(): void {
  ipcMain.handle('permissions:readiness', async () => {
    return (await getTrackingReadinessService().inspect()).readiness;
  });
  ipcMain.handle('permissions:requestScreen', async () => {
    return (await getTrackingReadinessService().requestScreenAccess()).readiness;
  });
}
