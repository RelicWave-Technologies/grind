import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  drainTimerSyncNow: vi.fn(),
  drainActivityNow: vi.fn(),
  currentVersion: 'version-1',
  refreshAgentConfig: vi.fn(),
}));

vi.mock('./apiClient', () => ({
  api: mocks.api,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

vi.mock('./auth', () => ({
  isLoggedIn: vi.fn(),
}));

vi.mock('./timer', () => ({
  drainTimerSyncNow: mocks.drainTimerSyncNow,
  getTimerService: () => ({
    status: () => ({ state: 'IDLE', paused: false, entryId: null }),
  }),
}));

vi.mock('./activity', () => ({
  drainActivityNow: mocks.drainActivityNow,
}));

vi.mock('./heartbeatPayload', () => ({
  buildHeartbeatRequest: () => ({ agentVersion: 'test', platform: 'darwin', state: 'IDLE' }),
  currentPlatform: () => 'darwin',
}));

vi.mock('./agentConfig', () => ({
  getAgentConfigVersion: () => mocks.currentVersion,
  refreshAgentConfig: mocks.refreshAgentConfig,
}));

describe('heartbeat config refresh', () => {
  beforeEach(() => {
    mocks.api.mockReset();
    mocks.drainTimerSyncNow.mockReset();
    mocks.drainActivityNow.mockReset();
    mocks.refreshAgentConfig.mockReset();
    mocks.currentVersion = 'version-1';
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('refreshes agent config when the server config version changes', async () => {
    mocks.api.mockResolvedValue({ ok: true, serverTime: '2026-07-04T00:00:00.000Z', configVersion: 'version-2' });
    const { sendHeartbeatNow } = await import('./heartbeat');

    sendHeartbeatNow();

    await vi.waitFor(() => expect(mocks.refreshAgentConfig).toHaveBeenCalledTimes(1));
    expect(mocks.drainTimerSyncNow).toHaveBeenCalledWith('heartbeat');
    expect(mocks.drainActivityNow).toHaveBeenCalledWith('heartbeat');
  });

  it('does not refresh agent config when the server version matches', async () => {
    mocks.api.mockResolvedValue({ ok: true, serverTime: '2026-07-04T00:00:00.000Z', configVersion: 'version-1' });
    const { sendHeartbeatNow } = await import('./heartbeat');

    sendHeartbeatNow();

    await vi.waitFor(() => expect(mocks.drainTimerSyncNow).toHaveBeenCalledWith('heartbeat'));
    expect(mocks.drainActivityNow).toHaveBeenCalledWith('heartbeat');
    expect(mocks.refreshAgentConfig).not.toHaveBeenCalled();
  });
});
