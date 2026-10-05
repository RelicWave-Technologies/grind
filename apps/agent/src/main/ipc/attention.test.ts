import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionAction, AttentionPrompt } from '../../shared/attention';

/**
 * A prompt can outlive the timer state it asked about. These drive the real
 * IPC handler with a prompt that has gone stale and assert it never acts on a
 * timer that is no longer the one it described.
 */

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  prompt: { kind: 'NONE' } as AttentionPrompt,
  clear: vi.fn(),
  status: vi.fn(),
  startTracking: vi.fn(),
  resumeTracking: vi.fn(),
  stopTracking: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, fn) },
}));
vi.mock('../services/trackingAttention', () => ({
  getTrackingAttentionCoordinator: () => ({ get: () => mocks.prompt, clear: mocks.clear }),
}));
vi.mock('../services/timer', () => ({ getTimerService: () => ({ status: mocks.status }) }));
vi.mock('../services/trackingCommands', () => ({
  clearPendingTrackingCommand: vi.fn(),
  retryPendingTrackingCommand: vi.fn(),
  resumeTracking: mocks.resumeTracking,
  startTracking: mocks.startTracking,
  stopTracking: mocks.stopTracking,
}));
vi.mock('../services/trackingReadiness', () => ({ getTrackingReadinessService: vi.fn() }));
vi.mock('../services/updates', () => ({ refreshUpdateInstallability: vi.fn() }));

const { registerAttentionIpc } = await import('./attention');
registerAttentionIpc();

const RUNNING = { state: 'RUNNING', entryId: 'e2', larkTaskGuid: 'task-now', paused: false };
const PAUSED = { ...RUNNING, paused: true };
const STOPPED = { state: 'IDLE', workedMs: 0 };

function answer(action: AttentionAction) {
  if (mocks.prompt.kind === 'NONE') throw new Error('no prompt');
  return mocks.handlers.get('attention:resolve')!({}, { promptId: mocks.prompt.promptId, action });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startTracking.mockResolvedValue({ ok: true, status: RUNNING });
  mocks.resumeTracking.mockResolvedValue({ ok: true, status: RUNNING });
  mocks.stopTracking.mockResolvedValue(STOPPED);
});

describe('answering a stale idle prompt', () => {
  beforeEach(() => {
    mocks.prompt = { kind: 'IDLE', promptId: 'idle-1', idleStartedAt: 100 };
  });

  it('"Stop timer" never stops a timer that was resumed elsewhere', async () => {
    mocks.status.mockReturnValue(RUNNING);

    const result = await answer('IDLE_BREAK');

    expect(mocks.stopTracking).not.toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledWith('idle-1');
    expect(result).toMatchObject({ ok: true, command: { ok: true, status: RUNNING } });
  });

  it('"Continue" does nothing to a timer that was stopped elsewhere', async () => {
    mocks.status.mockReturnValue(STOPPED);

    await answer('IDLE_CONTINUE');

    expect(mocks.resumeTracking).not.toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledWith('idle-1');
  });

  it('still stops a timer that is paused for idle', async () => {
    mocks.status.mockReturnValue(PAUSED);

    await answer('IDLE_BREAK');

    expect(mocks.stopTracking).toHaveBeenCalledTimes(1);
  });
});

describe('answering a stale welcome-back prompt', () => {
  beforeEach(() => {
    mocks.prompt = { kind: 'AWAY', promptId: 'away-1', larkTaskGuid: 'task-before', stoppedAt: 1, reason: 'lock' };
  });

  it('"Resume" does not switch the task the person is already tracking', async () => {
    mocks.status.mockReturnValue(RUNNING);

    await answer('AWAY_RESUME');

    expect(mocks.startTracking).not.toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledWith('away-1');
  });

  it('"Resume" restarts the old task when nothing is tracking', async () => {
    mocks.status.mockReturnValue(STOPPED);

    await answer('AWAY_RESUME');

    expect(mocks.startTracking).toHaveBeenCalledWith('task-before');
  });
});
