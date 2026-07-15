import { app, ipcMain, shell } from 'electron';
import Database from 'better-sqlite3';
import path from 'node:path';
import { api } from '../services/apiClient';
import { log } from '../logger';
import { dateKeyInTimeZone } from '@grind/types';
import { getWorkspaceTimeZone } from '../services/workspaceTime';
import { getTimerService, refreshTodayLedger } from '../services/timer';
import { loadTokens } from '../services/tokenStore';
import { LarkTaskCache, type CachedLarkTask } from '../services/larkTaskCache';

export type LarkStatus = {
  configured: boolean;
  connected: boolean;
  reauthRequired: boolean;
  scopes: string[];
  missingScopes?: string[];
  /** The API is unreachable; the UI may offer an owner-scoped saved task list. */
  offline?: boolean;
};

export type LarkTask = CachedLarkTask;

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
let taskCache: LarkTaskCache | null = null;

function getTaskCache(): LarkTaskCache {
  if (!taskCache) taskCache = new LarkTaskCache(new Database(path.join(app.getPath('userData'), 'agent.db')));
  return taskCache;
}

async function cachedTasks(): Promise<LarkTask[]> {
  const tokens = await loadTokens();
  return tokens ? getTaskCache().list(tokens) : [];
}

async function hasCachedTasks(): Promise<boolean> {
  const tokens = await loadTokens();
  return Boolean(tokens && getTaskCache().has(tokens));
}

async function cacheTasks(tasks: LarkTask[]): Promise<void> {
  const tokens = await loadTokens();
  if (tokens) getTaskCache().replace(tokens, tasks);
}

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

function withProjectedToday(tasks: LarkTask[]): LarkTask[] {
  const byTask = getTimerService().workedMsByTask();
  return tasks.map((task) => ({
    ...task,
    loggedTodayMs: byTask.get(task.guid) ?? task.loggedTodayMs,
  }));
}

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
      const cached = await hasCachedTasks();
      log.warn('lark:status unavailable', { cachedTasks: cached, err: String(err) });
      return { configured: true, connected: false, reauthRequired: false, scopes: [], offline: true };
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

  // Fetch fresh tasks when possible. Offline uses only the same user's durable
  // snapshot; it never claims that Lark is connected or lets the user create a
  // task without the server.
  ipcMain.handle('lark:tasks', async (): Promise<{ tasks: LarkTask[]; reauthRequired: boolean; offline?: boolean }> => {
    try {
      const { tasks } = await api<{ tasks: LarkTask[] }>(myTasksPath());
      await cacheTasks(tasks);
      return { tasks: withProjectedToday(tasks), reauthRequired: false };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('409')) return { tasks: [], reauthRequired: true };
      const tasks = withProjectedToday(await cachedTasks());
      log.warn('lark:tasks unavailable', { cachedTasks: tasks.length, err: msg });
      return { tasks, reauthRequired: false, offline: true };
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
        await cacheTasks(tasks);
        await refreshTodayLedger('manual');
        return {
          ok: true,
          connected: true,
          reauthRequired: false,
          tasks: withProjectedToday(tasks),
          syncedAt: Date.now(),
        };
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
