import { ipcMain, shell } from 'electron';
import { api } from '../services/apiClient';
import { log } from '../logger';

export type LarkStatus = {
  configured: boolean;
  connected: boolean;
  reauthRequired: boolean;
  scopes: string[];
};

export type LarkTask = { guid: string; summary: string; completed: boolean; url?: string };

/**
 * Lark connection is owned by the backend (tokens never touch the device).
 * The agent just (a) reads status, (b) opens the authorize URL in the system
 * browser, and (c) asks the backend to disconnect.
 */
export function registerLarkIpc(): void {
  ipcMain.handle('lark:status', async (): Promise<LarkStatus> => {
    try {
      return await api<LarkStatus>('/v1/lark/status');
    } catch (err) {
      log.warn('lark:status failed', { err: String(err) });
      return { configured: false, connected: false, reauthRequired: false, scopes: [] };
    }
  });

  // Open the OAuth authorize URL in the user's default browser. The backend
  // callback stores the tokens; the renderer then polls lark:status.
  ipcMain.handle('lark:connect', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const { authorizeUrl } = await api<{ authorizeUrl: string }>('/v1/lark/oauth/start');
      await shell.openExternal(authorizeUrl);
      return { ok: true };
    } catch (err) {
      log.warn('lark:connect failed', { err: String(err) });
      return { ok: false, error: String(err) };
    }
  });

  // Fetch the user's Lark tasks for the picker. Returns [] when not connected
  // (or on reauth), so the UI can degrade quietly without throwing.
  ipcMain.handle('lark:tasks', async (): Promise<{ tasks: LarkTask[]; reauthRequired: boolean }> => {
    try {
      const { tasks } = await api<{ tasks: LarkTask[] }>('/v1/lark/my-tasks');
      return { tasks, reauthRequired: false };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('409')) return { tasks: [], reauthRequired: true };
      log.warn('lark:tasks failed', { err: msg });
      return { tasks: [], reauthRequired: false };
    }
  });

  ipcMain.handle('lark:disconnect', async (): Promise<{ ok: boolean }> => {
    try {
      await api('/v1/lark/disconnect', { method: 'POST' });
      return { ok: true };
    } catch (err) {
      log.warn('lark:disconnect failed', { err: String(err) });
      return { ok: false };
    }
  });
}
