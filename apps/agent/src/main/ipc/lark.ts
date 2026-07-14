import { ipcMain, shell } from 'electron';
import { api } from '../services/apiClient';
import { log } from '../logger';
import { dateKeyInTimeZone } from '@grind/types';
import { getWorkspaceTimeZone } from '../services/workspaceTime';

export type LarkStatus = {
  configured: boolean;
  connected: boolean;
  reauthRequired: boolean;
  scopes: string[];
  missingScopes?: string[];
};

export type LarkTask = {
  guid: string;
  summary: string;
  completed: boolean;
  url?: string;
  due: number | null;
  createdAt: number | null;
  creatorId: string | null;
  creatorName: string | null;
  loggedMs: number;
  loggedTodayMs: number;
  loggedTotalMs: number;
};

export type CreateTaskInput = { summary: string; due?: number | null; description?: string | null };

export type LarkSyncResult = {
  ok: boolean;
  connected: boolean;
  reauthRequired: boolean;
  tasks: LarkTask[];
  syncedAt: number | null;
  error?: string;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function todayKey(): string {
  const timeZone = getWorkspaceTimeZone();
  if (!timeZone) throw new Error('workspace_time_unavailable');
  return dateKeyInTimeZone(new Date(), timeZone);
}

function myTasksPath(): string {
  const timeZone = getWorkspaceTimeZone();
  if (!timeZone) throw new Error('workspace_time_unavailable');
  const params = new URLSearchParams({
    date: todayKey(),
    tz: timeZone,
  });
  return `/v1/lark/my-tasks?${params.toString()}`;
}

function createTaskErrorMessage(raw: string): string {
  if (raw.includes('409')) return 'reauth_required';
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(jsonStart)) as { error?: string; detail?: string };
      if (body.detail) return body.detail;
      if (body.error === 'lark_create_failed') return 'Lark rejected the task';
      if (body.error === 'internal_error') return raw;
      if (body.error) return body.error;
    } catch {
      // Fall through to a generic message below.
    }
  }
  return 'Could not create task in Lark';
}

/**
 * Lark connection is owned by the backend (tokens never touch the device).
 * The agent just (a) reads status, (b) opens the authorize URL in the system
 * browser, and (c) asks the backend to disconnect.
 */
export function registerLarkIpc(): void {
  ipcMain.handle('lark:status', async (): Promise<LarkStatus> => {
    // Do NOT fabricate a "not configured / not connected" status on a transient
    // failure — that makes a stale or briefly-dropped connection look like "Lark
    // not set up" and hides the Sync button. Reject instead, so the renderer's
    // query keeps the last-known-good status until a later poll succeeds.
    try {
      return await api<LarkStatus>('/v1/lark/status');
    } catch (err) {
      log.warn('lark:status failed; keeping last-known status', { err: String(err) });
      throw err;
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
      const { tasks } = await api<{ tasks: LarkTask[] }>(myTasksPath());
      return { tasks, reauthRequired: false };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('409')) return { tasks: [], reauthRequired: true };
      // A transient failure must not blank the task list — reject so the
      // renderer keeps the last-known tasks and repopulates on the next poll.
      log.warn('lark:tasks failed; keeping last-known tasks', { err: msg });
      throw err;
    }
  });

  // Manual "Sync": refresh the connection + re-pull tasks in one shot, with
  // retry. Robustly distinguishes (a) not connected, (b) reauth needed (409),
  // (c) transient failure (retried up to 3×), so the UI can react precisely.
  ipcMain.handle('lark:sync', async (): Promise<LarkSyncResult> => {
    const empty = { tasks: [] as LarkTask[], syncedAt: null };
    const ATTEMPTS = 3;
    let lastErr = 'sync_failed';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        // Re-check the connection first — surfaces a dropped/expired link clearly.
        const status = await api<LarkStatus>('/v1/lark/status');
        if (!status.connected) {
          return { ok: false, connected: false, reauthRequired: status.reauthRequired, ...empty };
        }
        // Backend refreshes the Lark token here if needed; 409 ⇒ reauth required.
        const { tasks } = await api<{ tasks: LarkTask[] }>(myTasksPath());
        return { ok: true, connected: true, reauthRequired: false, tasks, syncedAt: Date.now() };
      } catch (err) {
        const msg = String(err);
        if (msg.includes('409')) {
          return { ok: false, connected: true, reauthRequired: true, ...empty, error: 'reauth_required' };
        }
        lastErr = msg;
        log.warn('lark:sync attempt failed', { attempt, err: msg });
        if (attempt < ATTEMPTS) await sleep(400 * attempt);
      }
    }
    return { ok: false, connected: true, reauthRequired: false, ...empty, error: lastErr };
  });

  // Create a Lark task. Returns {ok, task?} or {ok:false, error}.
  ipcMain.handle('lark:createTask', async (_e, input: CreateTaskInput): Promise<{ ok: boolean; task?: LarkTask; error?: string }> => {
    try {
      const { task } = await api<{ task: LarkTask }>('/v1/lark/tasks', { method: 'POST', body: input });
      return { ok: true, task };
    } catch (err) {
      const msg = String(err);
      log.warn('lark:createTask failed', { err: msg });
      return { ok: false, error: createTaskErrorMessage(msg) };
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
