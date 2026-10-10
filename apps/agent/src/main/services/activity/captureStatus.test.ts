import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trusted: true,
  hookStart: vi.fn(),
  hookStop: vi.fn(),
  hookOn: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: mocks.warn, debug: vi.fn(), error: vi.fn() },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/grind-test' },
}));

vi.mock('../agentDb', () => ({
  openAgentDb: () => ({}),
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
    mocks.warn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('backs off a failing hook instead of retrying and logging it every tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'));
    mocks.hookStart.mockImplementation(() => {
      throw new Error('hook refused');
    });
    const activity = await loadActivity();
    activity.startActivityCapture();

    // The 1s recording tick from main, for 15 seconds.
    for (let second = 0; second <= 15; second += 1) {
      activity.setActivityRecording(true, 'entry_1');
      vi.advanceTimersByTime(1_000);
    }

    // t=0, then +2s, +4s, +8s — not sixteen attempts.
    expect(mocks.hookStart).toHaveBeenCalledTimes(4);
    expect(mocks.warn.mock.calls.filter(([message]) => message === 'uIOhook.start failed')).toHaveLength(1);
    activity.stopActivityCapture();
  });

  it('caps the retry backoff at five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'));
    mocks.hookStart.mockImplementation(() => {
      throw new Error('hook refused');
    });
    const activity = await loadActivity();
    activity.startActivityCapture();

    for (let second = 0; second <= 30 * 60; second += 1) {
      activity.setActivityRecording(true, 'entry_1');
      vi.advanceTimersByTime(1_000);
    }
    const attemptsInFirstHalfHour = mocks.hookStart.mock.calls.length;
    for (let second = 0; second < 30 * 60; second += 1) {
      activity.setActivityRecording(true, 'entry_1');
      vi.advanceTimersByTime(1_000);
    }

    // Once capped, the next half hour sees exactly one attempt every 5 minutes.
    expect(mocks.hookStart.mock.calls.length - attemptsInFirstHalfHour).toBe(6);
    activity.stopActivityCapture();
  });

  it('lets an explicit retry clear a stored hook failure while not recording', async () => {
    mocks.hookStart.mockImplementationOnce(() => {
      throw new Error('hook refused');
    });
    const activity = await loadActivity();
    activity.startActivityCapture();
    activity.setActivityRecording(true, 'entry_1');
    // Paused for permission: recording stops, the failure is still stored.
    activity.setActivityRecording(false, null);
    expect(activity.getActivityCaptureStatus().lastHookError).toBe('Error: hook refused');

    const status = activity.retryActivityHook();

    expect(mocks.hookStart).toHaveBeenCalledTimes(2);
    // Not recording, so the proven hook is stopped again at once.
    expect(mocks.hookStop).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({ lastHookError: null, hookRunning: false, recording: false });
    activity.stopActivityCapture();
  });

  it('keeps the failure when the explicit retry fails too', async () => {
    mocks.hookStart.mockImplementation(() => {
      throw new Error('hook refused');
    });
    const activity = await loadActivity();
    activity.startActivityCapture();
    activity.setActivityRecording(true, 'entry_1');

    expect(activity.retryActivityHook().lastHookError).toBe('Error: hook refused');
    expect(mocks.hookStart).toHaveBeenCalledTimes(2);
    activity.stopActivityCapture();
  });
});
