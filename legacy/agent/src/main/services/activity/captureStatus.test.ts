import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trusted: true,
  hookStart: vi.fn(),
  hookStop: vi.fn(),
  hookOn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/grind-test' },
}));

vi.mock('better-sqlite3', () => ({
  default: class Database {},
}));

vi.mock('uiohook-napi', () => ({
  uIOhook: {
    start: mocks.hookStart,
    stop: mocks.hookStop,
    on: mocks.hookOn,
  },
}));

vi.mock('../permissions', () => ({
  hasAccessibilityAccess: () => mocks.trusted,
}));

vi.mock('../agentConfig', () => ({
  getCapturePolicy: () => ({ captureApps: false, captureTitles: false, captureUrls: false }),
}));

vi.mock('./activeWindow', () => ({
  ActiveWindowTracker: class ActiveWindowTracker {
    observe(): void {}
    clear(): void {}
    prune(): void {}
    dominantFor(): { activeApp: null; activeAppBundle: null; activeTitle: null; activeUrl: null } {
      return { activeApp: null, activeAppBundle: null, activeTitle: null, activeUrl: null };
    }
  },
}));

vi.mock('./store', () => ({
  ActivityStore: class ActivityStore {
    insert(): void {}
    scrubActiveFields(): number { return 0; }
    countSince(): { keystrokes: number; clicks: number; scrollEvents: number } {
      return { keystrokes: 0, clicks: 0, scrollEvents: 0 };
    }
  },
}));

vi.mock('./sync', () => ({
  flushActivity: vi.fn().mockResolvedValue(0),
}));

async function loadActivity() {
  vi.resetModules();
  return import('./index');
}

describe('activity capture status', () => {
  beforeEach(() => {
    mocks.trusted = true;
    mocks.hookStart.mockReset();
    mocks.hookStop.mockReset();
    mocks.hookOn.mockReset();
  });

  it('does not report capturing when uIOhook.start fails', async () => {
    mocks.hookStart.mockImplementation(() => {
      throw new Error('native hook denied');
    });
    const activity = await loadActivity();

    activity.startActivityCapture();
    activity.setActivityRecording(true, 'entry_1');

    expect(activity.getActivityCaptureStatus()).toMatchObject({
      trusted: true,
      ready: true,
      recording: true,
      hookRunning: false,
      capturing: false,
      lastHookError: 'Error: native hook denied',
    });
    activity.stopActivityCapture();
  });

  it('reports ready but not capturing when trusted and idle', async () => {
    const activity = await loadActivity();

    activity.startActivityCapture();
    activity.setActivityRecording(false, null);

    expect(activity.getActivityCaptureStatus()).toMatchObject({
      trusted: true,
      ready: true,
      recording: false,
      hookRunning: false,
      capturing: false,
      lastHookError: null,
    });
    activity.stopActivityCapture();
  });

  it('reports capturing only while recording and the native hook is running', async () => {
    const activity = await loadActivity();

    activity.startActivityCapture();
    activity.setActivityRecording(true, 'entry_1');

    expect(mocks.hookStart).toHaveBeenCalledTimes(1);
    expect(activity.getActivityCaptureStatus()).toMatchObject({
      trusted: true,
      ready: true,
      recording: true,
      hookRunning: true,
      capturing: true,
    });
    activity.stopActivityCapture();
  });
});
