import { ipcMain, type BrowserWindow } from 'electron';
import { login, logout, isLoggedIn } from '../services/auth';
import { onAuthChange } from '../services/apiClient';
import { startHeartbeat, stopHeartbeat } from '../services/heartbeat';
import { log } from '../logger';

export function registerAuthIpc(win: BrowserWindow): void {
  ipcMain.handle('auth:login', async (_e, payload: { email: string; password: string }) => {
    const user = await login(payload.email, payload.password);
    startHeartbeat();
    win.webContents.send('auth:status:push', 'loggedIn');
    return user;
  });

  ipcMain.handle('auth:logout', async () => {
    stopHeartbeat();
    await logout();
    win.webContents.send('auth:status:push', 'loggedOut');
    return { ok: true };
  });

  ipcMain.handle('auth:status', async () => {
    return (await isLoggedIn()) ? 'loggedIn' : 'loggedOut';
  });

  onAuthChange((status) => {
    log.info('auth status change pushed', { status });
    win.webContents.send('auth:status:push', status);
    if (status === 'loggedOut') stopHeartbeat();
  });
}
