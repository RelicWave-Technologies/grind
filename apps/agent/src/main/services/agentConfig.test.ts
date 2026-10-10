import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userData = '';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  loadTokens: vi.fn(),
  applyServerWorkspaceTimeZone: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getPath: () => userData } }));
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

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.applyServerWorkspaceTimeZone.mockResolvedValue(undefined);
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'timo-agent-config-'));
});

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true });
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

describe('agent config offline cache', () => {
  it('an offline boot runs on the last config this account received, not the build defaults', async () => {
    mocks.loadTokens.mockResolvedValue(sessionA);
    mocks.api.mockResolvedValue({ ...config, idleThresholdMin: 12, todayLedgerMode: 'VISIBLE' as const });
    await (await import('./agentConfig')).refreshAgentConfig();

    vi.resetModules(); // a new process
    mocks.api.mockRejectedValue(new Error('fetch failed'));
    const offline = await import('./agentConfig');
    await offline.refreshAgentConfig();

    expect(offline.getIdleThresholdSec()).toBe(12 * 60);
    expect(offline.getTodayLedgerMode()).toBe('VISIBLE');
    // The business day restores from its own cache, not from this one.
    expect(mocks.applyServerWorkspaceTimeZone).toHaveBeenCalledTimes(1);
  });

  it("never applies another account's cached policy", async () => {
    mocks.loadTokens.mockResolvedValue(sessionA);
    mocks.api.mockResolvedValue({ ...config, idleThresholdMin: 12 });
    await (await import('./agentConfig')).refreshAgentConfig();

    vi.resetModules();
    mocks.loadTokens.mockResolvedValue(sessionB);
    mocks.api.mockRejectedValue(new Error('fetch failed'));
    const offline = await import('./agentConfig');
    await offline.refreshAgentConfig();

    expect(offline.getIdleThresholdSec()).toBe(300);
  });
});
