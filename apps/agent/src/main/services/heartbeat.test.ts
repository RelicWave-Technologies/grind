import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  drainTimerSyncNow: vi.fn(),
  drainActivityNow: vi.fn(),
  getActivityCaptureStatus: vi.fn(),
  currentVersion: 'version-1',
  refreshAgentConfig: vi.fn(),
  appVersion: '9.8.7',
  getScreenHealth: vi.fn(),
  screenStatus: vi.fn(),
  screenUiState: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  startupHealth: {
    state: 'READY',
    ready: true,
    openedAtLogin: true,
  },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => mocks.appVersion,
  },
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
  getActivityCaptureStatus: mocks.getActivityCaptureStatus,
}));

vi.mock('./capture', () => ({
  getScreenHealth: mocks.getScreenHealth,
}));

vi.mock('./permissions', () => ({
  screenStatus: mocks.screenStatus,
  screenUiState: mocks.screenUiState,
}));

vi.mock('./heartbeatPayload', () => ({
  buildHeartbeatRequest: (args: { agentVersion: string; permissions?: unknown; startup?: unknown }) => ({
    agentVersion: args.agentVersion,
    platform: 'darwin',
    state: 'IDLE',
    permissions: args.permissions,
    startup: args.startup,
  }),
  currentPlatform: () => 'darwin',
}));

vi.mock('./launchAtLogin', () => ({
  getLaunchAtLoginService: () => ({
    inspect: () => mocks.startupHealth,
    launchOrigin: () => 'LOGIN_ITEM',
  }),
}));

vi.mock('./agentConfig', () => ({
  getAgentConfigVersion: () => mocks.currentVersion,
  refreshAgentConfig: mocks.refreshAgentConfig,
}));

vi.mock('../logger', () => ({
  log: {
    debug: mocks.logDebug,
    warn: mocks.logWarn,
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('heartbeat config refresh', () => {
  beforeEach(() => {
    mocks.api.mockReset();
    mocks.drainTimerSyncNow.mockReset();
    mocks.drainActivityNow.mockReset();
    mocks.getActivityCaptureStatus.mockReset();
    mocks.refreshAgentConfig.mockReset();
    mocks.getScreenHealth.mockReset();
    mocks.screenStatus.mockReset();
    mocks.screenUiState.mockReset();
    mocks.logWarn.mockReset();
    mocks.logDebug.mockReset();
    mocks.currentVersion = 'version-1';
    mocks.appVersion = '9.8.7';
    mocks.getScreenHealth.mockReturnValue('ok');
    mocks.screenStatus.mockReturnValue('granted');
    mocks.screenUiState.mockReturnValue('ok');
    mocks.getActivityCaptureStatus.mockReturnValue({
      trusted: true,
      ready: true,
      recording: false,
      capturing: false,
      hookRunning: false,
      lastHookError: null,
    });
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

  it('sends the packaged app version in the heartbeat payload', async () => {
    mocks.api.mockResolvedValue({ ok: true, serverTime: '2026-07-04T00:00:00.000Z', configVersion: 'version-1' });
    const { sendHeartbeatNow } = await import('./heartbeat');

    sendHeartbeatNow();

    await vi.waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        '/v1/agent/heartbeat',
        expect.objectContaining({
          body: expect.objectContaining({ agentVersion: '9.8.7' }),
        }),
      ),
    );
  });

  it('sends the local desktop permission snapshot in the heartbeat payload', async () => {
    mocks.getScreenHealth.mockReturnValue('empty');
    mocks.screenStatus.mockReturnValue('granted');
    mocks.screenUiState.mockReturnValue('needs-restart');
    mocks.getActivityCaptureStatus.mockReturnValue({
      trusted: true,
      ready: true,
      recording: true,
      capturing: false,
      hookRunning: false,
      lastHookError: 'native hook stopped',
    });
    mocks.api.mockResolvedValue({ ok: true, serverTime: '2026-07-04T00:00:00.000Z', configVersion: 'version-1' });
    const { sendHeartbeatNow } = await import('./heartbeat');

    sendHeartbeatNow();

    await vi.waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        '/v1/agent/heartbeat',
        expect.objectContaining({
          body: expect.objectContaining({
            permissions: {
              screen: { status: 'granted', health: 'empty', state: 'needs-restart' },
              accessibility: {
                trusted: true,
                ready: true,
                recording: true,
                capturing: false,
                hookRunning: false,
              },
            },
          }),
        }),
      ),
    );
  });

  it('sends launch-at-login health without local paths', async () => {
    mocks.api.mockResolvedValue({ ok: true, serverTime: '2026-07-04T00:00:00.000Z', configVersion: 'version-1' });
    const { sendHeartbeatNow } = await import('./heartbeat');

    sendHeartbeatNow();

    await vi.waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        '/v1/agent/heartbeat',
        expect.objectContaining({
          body: expect.objectContaining({
            startup: {
              state: 'READY',
              ready: true,
              openedAtLogin: true,
              origin: 'LOGIN_ITEM',
            },
          }),
        }),
      ),
    );
  });

  it('does not refresh agent config when the server version matches', async () => {
    mocks.api.mockResolvedValue({ ok: true, serverTime: '2026-07-04T00:00:00.000Z', configVersion: 'version-1' });
    const { sendHeartbeatNow } = await import('./heartbeat');

    sendHeartbeatNow();

    await vi.waitFor(() => expect(mocks.drainActivityNow).toHaveBeenCalledWith('heartbeat'));
    expect(mocks.drainTimerSyncNow).toHaveBeenCalledWith('heartbeat');
    expect(mocks.refreshAgentConfig).not.toHaveBeenCalled();
  });

  it('keeps heartbeat errors contained when local permission collection fails', async () => {
    mocks.screenStatus.mockImplementationOnce(() => {
      throw new Error('permission probe failed');
    });
    const { sendHeartbeatNow } = await import('./heartbeat');

    sendHeartbeatNow();

    await vi.waitFor(() =>
      expect(mocks.logWarn).toHaveBeenCalledWith(
        'heartbeat failed',
        expect.objectContaining({ err: expect.stringContaining('permission probe failed') }),
      ),
    );
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
