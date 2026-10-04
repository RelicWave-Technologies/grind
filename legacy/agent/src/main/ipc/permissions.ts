import { ipcMain } from 'electron';
import { getTrackingReadinessService } from '../services/trackingReadiness';

export function registerPermissionsIpc(): void {
  ipcMain.handle('permissions:readiness', async () => {
    // Probe when we do not yet know. The polling path used to call inspect()
    // with no options, so the one call that could resolve CHECKING never ran and
    // the surface sat on a stale verdict offering a useless Restart button.
    const service = getTrackingReadinessService();
    const first = await service.inspect();
    if (first.readiness.screenRecording !== 'CHECKING') return first.readiness;
    return (await service.inspect({ verifyScreen: true })).readiness;
  });
  ipcMain.handle('permissions:requestScreen', async () => {
    return (await getTrackingReadinessService().requestScreenAccess()).readiness;
  });
}
