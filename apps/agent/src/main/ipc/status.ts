import { ipcMain } from 'electron';
import { getStatus } from '../services/heartbeat';

export function registerStatusIpc(): void {
  ipcMain.handle('agent:status', () => {
    const s = getStatus();
    return { state: s.running ? 'IDLE' : 'OFFLINE', lastHeartbeatAt: s.lastHeartbeatAt };
  });
}
