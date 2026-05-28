import { ipcMain } from 'electron';
import { login, logout, isLoggedIn } from '../services/auth';
import { onAuthChange } from '../services/apiClient';
import { startHeartbeat, stopHeartbeat } from '../services/heartbeat';
import { broadcast } from '../broadcast';
import { log } from '../logger';

export function registerAuthIpc(): void {
  ipcMain.handle('auth:login', async (_e, payload: { email: string; password: string }) => {
    const user = await login(payload.email, payload.password);
    startHeartbeat();
    broadcast('auth:status:push', 'loggedIn');
    return user;
  });

  ipcMain.handle('auth:logout', async () => {
    stopHeartbeat();
    await logout();
    broadcast('auth:status:push', 'loggedOut');
    return { ok: true };
  });

  ipcMain.handle('auth:status', async () => {
    return (await isLoggedIn()) ? 'loggedIn' : 'loggedOut';
  });

  onAuthChange((status) => {
    log.info('auth status change pushed', { status });
    broadcast('auth:status:push', status);
    if (status === 'loggedOut') stopHeartbeat();
  });
}
