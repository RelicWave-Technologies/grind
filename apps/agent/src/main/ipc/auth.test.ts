import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const timer = {
    running: true,
    unsynced: false,
    unsyncedAfterStop: false,
    isRunning: vi.fn(() => timer.running),
    hasUnsynced: vi.fn(() => timer.unsynced),
    syncBacklog: vi.fn(() => ({ pending: 1, oldestPendingAt: null, lastError: 'offline' })),
    stop: vi.fn(async () => {
      calls.push('stop');
      timer.running = false;
      timer.unsynced = timer.unsyncedAfterStop;
    }),
  };
  return {
    calls,
    timer,
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    drain: vi.fn(async () => {
      calls.push('drain');
    }),
    logout: vi.fn(async () => {
      calls.push('logout');
    }),
    bind: vi.fn(async () => {
      calls.push('bind');
      return false;
    }),
    stopHeartbeat: vi.fn(() => {
      calls.push('stopHeartbeat');
    }),
    notifyAuth: vi.fn((status: string, info: unknown) => {
      calls.push(`notify:${status}:${JSON.stringify(info)}`);
    }),
    ensureSession: vi.fn(async () => false),
    startLarkLogin: vi.fn(async () => undefined),
    activate: vi.fn(async () => true),
    stopUploads: vi.fn(async () => {
      calls.push('stopUploads:start');
      await new Promise((resolve) => setTimeout(resolve, 5)); // the running pass winds down
      calls.push('stopUploads:done');
    }),
    resumeUploads: vi.fn(() => {
      calls.push('resumeUploads');
    }),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, fn),
  },
}));
vi.mock('../services/auth', () => ({
  logout: mocks.logout,
  isLoggedIn: vi.fn(),
  startLarkLogin: mocks.startLarkLogin,
  ensureSession: mocks.ensureSession,
}));
vi.mock('../services/apiClient', () => ({ onAuthChange: vi.fn(), notifyAuth: mocks.notifyAuth, api: vi.fn() }));
vi.mock('../services/heartbeat', () => ({ stopHeartbeat: mocks.stopHeartbeat }));
vi.mock('../services/network', () => ({ networkFetch: vi.fn() }));
vi.mock('../services/signIn', () => ({ activateSignedInSession: mocks.activate }));
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../services/timer', () => ({
  bindTimerToStoredSession: mocks.bind,
  drainTimerSyncNow: mocks.drain,
  getTimerService: () => mocks.timer,
}));

vi.mock('../services/capture/uploader', () => ({
  stopUploads: mocks.stopUploads,
  resumeUploads: mocks.resumeUploads,
}));

const { registerAuthIpc } = await import('./auth');
registerAuthIpc();

function invoke(channel: string): Promise<unknown> {
  return Promise.resolve(mocks.handlers.get(channel)!({}));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.timer.running = true;
  mocks.timer.unsynced = false;
  mocks.timer.unsyncedAfterStop = false;
});

describe('auth:logout', () => {
  it('refuses before touching the timer when tracked time cannot sync', async () => {
    mocks.timer.unsynced = true;

    await expect(invoke('auth:logout')).resolves.toEqual({ ok: false, reason: 'time_waiting_to_sync' });

    expect(mocks.timer.stop).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.timer.running).toBe(true);
  });

  it('checks sync first, then stops, then signs out as a manual sign-out', async () => {
    await expect(invoke('auth:logout')).resolves.toEqual({ ok: true });

    expect(mocks.calls).toEqual([
      'drain',
      'stop',
      'drain',
      'stopUploads:start',
      'stopUploads:done',
      'stopHeartbeat',
      'logout',
      'bind',
      'resumeUploads',
      'notify:loggedOut:{"reason":"manual"}',
    ]);
  });

  it('never stops the timer and then fails: a final close that stays queued still signs out', async () => {
    mocks.timer.unsyncedAfterStop = true;

    await expect(invoke('auth:logout')).resolves.toEqual({ ok: true });

    expect(mocks.timer.stop).toHaveBeenCalledOnce();
    expect(mocks.logout).toHaveBeenCalledOnce();
  });

  it('signs out without a stop when nothing is running', async () => {
    mocks.timer.running = false;

    await expect(invoke('auth:logout')).resolves.toEqual({ ok: true });

    expect(mocks.timer.stop).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual([
      'drain',
      'stopUploads:start',
      'stopUploads:done',
      'stopHeartbeat',
      'logout',
      'bind',
      'resumeUploads',
      'notify:loggedOut:{"reason":"manual"}',
    ]);
  });

  it('lets screenshot uploads run again even when logout throws', async () => {
    mocks.logout.mockRejectedValueOnce(new Error('disk'));

    await expect(invoke('auth:logout')).rejects.toThrow('disk');

    expect(mocks.stopUploads).toHaveBeenCalledOnce();
    expect(mocks.resumeUploads).toHaveBeenCalledOnce();
  });

  it('runs one sign-out for a double click', async () => {
    const [a, b] = await Promise.all([invoke('auth:logout'), invoke('auth:logout')]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(mocks.logout).toHaveBeenCalledOnce();
  });
});

describe('auth:loginWithLark', () => {
  it('activates a still-valid stored session through the shared sign-in path', async () => {
    mocks.ensureSession.mockResolvedValueOnce(true);

    await invoke('auth:loginWithLark');

    expect(mocks.activate).toHaveBeenCalledWith('stored_session');
    expect(mocks.startLarkLogin).not.toHaveBeenCalled();
  });

  it('opens the browser when there is no session to reuse', async () => {
    await invoke('auth:loginWithLark');

    expect(mocks.startLarkLogin).toHaveBeenCalledOnce();
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});
