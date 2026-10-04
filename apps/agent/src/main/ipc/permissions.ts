import { ipcMain } from 'electron';
import { getTrackingReadinessService } from '../services/trackingReadiness';

export function registerPermissionsIpc(): void {
  ipcMain.handle('permissions:readiness', async () => {
    // Verify on every poll: while the screen is granted but unverified the
    // service re-probes at its own throttled pace, so a blank first capture
    // resolves itself instead of leaving the surface on a stale verdict.
    return (await getTrackingReadinessService().inspect({ verifyScreen: true })).readiness;
  });
  ipcMain.handle('permissions:recheck', async () => {
    return (await getTrackingReadinessService().recheck()).readiness;
  });
  ipcMain.handle('permissions:requestScreen', async () => {
    return (await getTrackingReadinessService().requestScreenAccess()).readiness;
  });
}
