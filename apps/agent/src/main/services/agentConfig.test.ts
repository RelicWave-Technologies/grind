import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  loadTokens: vi.fn(),
  applyServerWorkspaceTimeZone: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./apiClient', () => ({ api: mocks.api }));
vi.mock('./tokenStore', () => ({ loadTokens: mocks.loadTokens }));
vi.mock('./workspaceTime', () => ({
  applyServerWorkspaceTimeZone: mocks.applyServerWorkspaceTimeZone,
}));
vi.mock('../logger', () => ({
  log: { info: mocks.info, warn: mocks.warn },
}));
vi.mock('../env', () => ({
  SCREENSHOT_INTERVAL_SEC: 600,
  IDLE_THRESHOLD_SEC: 300,
  SHOT_SEC_LOCKED: false,
  IDLE_SEC_LOCKED: false,
}));

const sessionA = {
  accessToken: 'at_a',
  refreshToken: 'rt_a',
  userId: 'user_a',
  workspaceId: 'workspace_a',
};
const sessionB = {
  accessToken: 'at_b',
  refreshToken: 'rt_b',
  userId: 'user_b',
  workspaceId: 'workspace_b',
};
const config = {
  configVersion: 'config_1',
  heartbeatIntervalSec: 60,
  screenshotIntervalMin: 3,
  idleThresholdMin: 5,
  captureApps: false,
  captureTitles: false,
  captureUrls: false,
  todayLedgerMode: 'SHADOW' as const,
  dashboardUrl: 'https://timo.example',
  workspaceTimezone: 'Asia/Kolkata',
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.applyServerWorkspaceTimeZone.mockResolvedValue(undefined);
});

describe('agent config session isolation', () => {
  it('applies config to the workspace that requested it', async () => {
    mocks.loadTokens.mockResolvedValue(sessionA);
    mocks.api.mockResolvedValue(config);
    const { getTodayLedgerMode, refreshAgentConfig } = await import('./agentConfig');

    await refreshAgentConfig();

    expect(mocks.applyServerWorkspaceTimeZone).toHaveBeenCalledWith('Asia/Kolkata', 'workspace_a');
    expect(getTodayLedgerMode()).toBe('SHADOW');
  });

  it('discards an old account response and refreshes the newly active session', async () => {
    let resolveFirst!: (value: typeof config) => void;
    const firstResponse = new Promise<typeof config>((resolve) => {
      resolveFirst = resolve;
    });
    mocks.loadTokens.mockResolvedValue(sessionB).mockResolvedValueOnce(sessionA);
    mocks.api.mockReturnValueOnce(firstResponse).mockResolvedValueOnce(config);
    const { refreshAgentConfig } = await import('./agentConfig');

    const oldRefresh = refreshAgentConfig();
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
    const newRefresh = refreshAgentConfig();
    resolveFirst(config);
    await Promise.all([oldRefresh, newRefresh]);

    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.applyServerWorkspaceTimeZone).toHaveBeenCalledTimes(1);
    expect(mocks.applyServerWorkspaceTimeZone).toHaveBeenCalledWith('Asia/Kolkata', 'workspace_b');
    expect(mocks.info).toHaveBeenCalledWith(
      'agent config response discarded because the stored session changed',
    );
  });
});
