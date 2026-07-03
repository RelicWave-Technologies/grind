import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  policy: { captureApps: false, captureTitles: false, captureUrls: false },
  activeWindow: vi.fn(),
  recordActiveWindow: vi.fn(),
  noteRunningApp: vi.fn(),
}));

vi.mock('../agentConfig', () => ({
  getCapturePolicy: () => mocks.policy,
}));

vi.mock('../timer', () => ({
  getTimerService: () => ({
    status: () => ({ state: 'RUNNING', paused: false }),
  }),
}));

vi.mock('./index', () => ({
  recordActiveWindow: mocks.recordActiveWindow,
}));

vi.mock('../appIcons', () => ({
  noteRunningApp: mocks.noteRunningApp,
}));

vi.mock('get-windows', () => ({
  activeWindow: mocks.activeWindow,
}));

describe('active-window polling policy gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.policy = { captureApps: false, captureTitles: false, captureUrls: false };
    mocks.activeWindow.mockReset();
    mocks.recordActiveWindow.mockReset();
    mocks.noteRunningApp.mockReset();
  });

  afterEach(async () => {
    const { stopActiveWindowPolling } = await import('./windowPoller');
    stopActiveWindowPolling();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('does not call active-window detection when app capture is disabled', async () => {
    const { startActiveWindowPolling } = await import('./windowPoller');

    startActiveWindowPolling();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.activeWindow).not.toHaveBeenCalled();
    expect(mocks.recordActiveWindow).not.toHaveBeenCalled();
    expect(mocks.noteRunningApp).not.toHaveBeenCalled();
  });

  it('drops title and URL before recording when those flags are disabled', async () => {
    mocks.policy = { captureApps: true, captureTitles: false, captureUrls: false };
    mocks.activeWindow.mockResolvedValue({
      owner: { name: 'Google Chrome', bundleId: 'com.google.Chrome', path: '/Applications/Google Chrome.app' },
      title: 'Inbox',
      url: 'https://mail.example.test',
    });
    const { startActiveWindowPolling } = await import('./windowPoller');

    startActiveWindowPolling();
    await vi.advanceTimersByTimeAsync(10_000);

    await vi.waitFor(() => expect(mocks.activeWindow).toHaveBeenCalledTimes(1));
    expect(mocks.recordActiveWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        app: 'Google Chrome',
        appBundle: 'com.google.Chrome',
        title: null,
        url: null,
      }),
    );
    expect(mocks.noteRunningApp).toHaveBeenCalledWith({
      app: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      path: '/Applications/Google Chrome.app',
    });
  });
});
