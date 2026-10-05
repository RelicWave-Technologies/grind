import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  api: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => ':memory:' },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, fn) },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../services/apiClient', async () => {
  class HttpError extends Error {
    constructor(readonly path: string, readonly status: number, readonly body: string) {
      super(`${path} ${status}: ${body}`);
    }
  }
  return { api: mocks.api, HttpError };
});
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../services/workspaceTime', () => ({ getWorkspaceTimeZone: () => 'UTC' }));
vi.mock('../services/timer', () => ({
  getTimerService: () => ({ workedMsByTask: () => new Map() }),
  refreshTodayLedger: vi.fn(),
}));
vi.mock('../services/agentConfig', () => ({ refreshAgentConfig: vi.fn() }));
vi.mock('../services/tokenStore', () => ({ loadTokens: vi.fn(async () => null) }));

const { HttpError } = await import('../services/apiClient');
const { registerLarkIpc } = await import('./lark');
registerLarkIpc();

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(mocks.handlers.get(channel)!({}, ...args));
}

beforeEach(() => {
  mocks.api.mockReset();
});

describe('Lark reauth detection', () => {
  it('treats a 409 as a grant that needs re-authorising', async () => {
    mocks.api.mockRejectedValue(new HttpError('/v1/lark/my-tasks', 409, '{"error":"lark_reauth_required"}'));

    await expect(invoke('lark:tasks')).resolves.toEqual({ tasks: [], reauthRequired: true });
  });

  it('does not mistake "409" inside another failure for a reauth', async () => {
    mocks.api.mockRejectedValue(new HttpError('/v1/lark/my-tasks?date=2026-04-09', 500, 'trace 409'));

    await expect(invoke('lark:tasks')).resolves.toMatchObject({ reauthRequired: false, offline: true });
  });

  it('reports reauth from task creation by status, and other errors by their body', async () => {
    mocks.api.mockRejectedValueOnce(new HttpError('/v1/lark/tasks', 409, '{}'));
    await expect(invoke('lark:createTask', { summary: 'x' })).resolves.toEqual({ ok: false, error: 'reauth_required' });

    mocks.api.mockRejectedValueOnce(new HttpError('/v1/lark/tasks', 400, '{"error":"lark_create_failed"}'));
    await expect(invoke('lark:createTask', { summary: 'x' })).resolves.toEqual({ ok: false, error: 'Lark rejected the task' });
  });
});
