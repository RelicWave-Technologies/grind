import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: null as { userId: string; workspaceId: string } | null,
  persistMinute: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: mocks.error } }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/grind-test' } }));
vi.mock('../agentDb', () => ({ openAgentDb: () => ({}) }));
vi.mock('uiohook-napi', () => ({ uIOhook: { start: vi.fn(), stop: vi.fn(), on: vi.fn() } }));
vi.mock('../permissions', () => ({ hasAccessibilityAccess: () => true }));
vi.mock('../agentConfig', () => ({
  getCapturePolicy: () => ({ captureApps: false, captureTitles: false, captureUrls: false }),
}));
vi.mock('../serverClock', () => ({ serverAlignedNow: () => Date.now() }));
vi.mock('../tokenStore', () => ({ loadTokens: vi.fn().mockResolvedValue(null) }));
vi.mock('../timer', () => ({
  drainTimerSyncNow: vi.fn().mockResolvedValue(undefined),
  getTimerService: () => ({ currentOwner: () => mocks.owner, isPendingCreate: () => false }),
}));
vi.mock('./activeWindow', () => ({
  ActiveWindowTracker: class ActiveWindowTracker {
    observe(): void {}
    clear(): void {}
    prune(): void {}
    dominantFor() {
      return { activeApp: null, activeAppBundle: null, activeTitle: null, activeUrl: null };
    }
  },
}));
vi.mock('./store', () => ({
  ActivityStore: class ActivityStore {
    persistMinute = mocks.persistMinute;
    claimUnowned(): number {
      return 0;
    }
  },
}));
vi.mock('./sync', () => ({ flushActivity: vi.fn().mockResolvedValue(0) }));

const ALICE = { userId: 'alice', workspaceId: 'w1' };

describe('activity minute sealing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));
    mocks.owner = ALICE;
    mocks.persistMinute.mockReset().mockReturnValue(false);
    mocks.error.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps a minute with the account that recorded it, even if it signed out before the seal', async () => {
    const activity = await import('./index');
    activity.startActivityCapture();
    activity.setActivityRecording(true, 'e1');
    activity.setActivityRecording(true, 'e1'); // the 1s tick: the hook is listening now
    mocks.owner = null; // signed out before the minute boundary
    activity.setActivityRecording(false, null);

    await vi.advanceTimersByTimeAsync(61_000);

    expect(mocks.persistMinute).toHaveBeenCalledTimes(1);
    expect(mocks.persistMinute.mock.calls[0]![0]).toMatchObject({
      timeEntryId: 'e1',
      ownerUserId: 'alice',
      ownerWorkspaceId: 'w1',
    });
    activity.stopActivityCapture();
  });

  it('keeps sealing every minute after one seal throws', async () => {
    mocks.persistMinute.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY');
    });
    const activity = await import('./index');
    activity.startActivityCapture();
    activity.setActivityRecording(true, 'e1');
    activity.setActivityRecording(true, 'e1'); // the 1s tick: the hook is listening now

    await vi.advanceTimersByTimeAsync(61_000);
    expect(mocks.error).toHaveBeenCalledWith('activity minute seal failed', expect.anything());

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.persistMinute).toHaveBeenCalledTimes(2);
    activity.stopActivityCapture();
  });
});
