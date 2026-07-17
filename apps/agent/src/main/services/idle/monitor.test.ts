import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  idleSeconds: 0,
  running: true,
  paused: false,
  threshold: 10,
  warning: null as number | null,
}));

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => state.idleSeconds } }));
vi.mock('../timer', () => ({
  getTimerService: () => ({
    status: () => state.running
      ? { state: 'RUNNING', paused: state.paused }
      : { state: 'IDLE' },
  }),
}));
vi.mock('../agentConfig', () => ({
  getIdleThresholdSec: () => state.threshold,
  getIdleWarningSeconds: () => state.warning,
}));
vi.mock('../../env', () => ({ IDLE_POLL_MS: 1000 }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { IdleMonitor } = await import('./monitor');

const tick = (monitor: InstanceType<typeof IdleMonitor>) =>
  (monitor as unknown as { tick(): Promise<void> }).tick();

function setup() {
  const handlers = {
    onWarning: vi.fn(async () => true),
    onWarningCancelled: vi.fn(),
    onIdle: vi.fn(async () => true),
  };
  return { handlers, monitor: new IdleMonitor(handlers) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
});

afterEach(() => {
  state.idleSeconds = 0;
  state.running = true;
  state.paused = false;
  state.threshold = 10;
  state.warning = null;
  vi.useRealTimers();
});

describe('IdleMonitor two-stage gating', () => {
  it('keeps the existing direct idle pause when warning is disabled', async () => {
    state.idleSeconds = 10;
    const { handlers, monitor } = setup();

    await tick(monitor);

    expect(handlers.onWarning).not.toHaveBeenCalled();
    expect(handlers.onIdle).toHaveBeenCalledTimes(1);
    expect(monitor.isPrompting()).toBe(true);
  });

  it('shows one warning before the threshold without pausing', async () => {
    state.warning = 3;
    state.idleSeconds = 7;
    const { handlers, monitor } = setup();

    await tick(monitor);
    await tick(monitor);

    expect(handlers.onWarning).toHaveBeenCalledTimes(1);
    expect(handlers.onWarning).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAt: Date.now() + 3000,
    }));
    expect(handlers.onIdle).not.toHaveBeenCalled();
    monitor.resolve();
  });

  it('dismisses the warning automatically when activity returns', async () => {
    state.warning = 3;
    state.idleSeconds = 7;
    const { handlers, monitor } = setup();
    await tick(monitor);

    state.idleSeconds = 0;
    await tick(monitor);

    expect(handlers.onWarningCancelled).toHaveBeenCalledTimes(1);
    expect(monitor.isPrompting()).toBe(false);
  });

  it('dismisses the warning immediately when tracked input returns', async () => {
    state.warning = 3;
    state.idleSeconds = 7;
    const { handlers, monitor } = setup();
    await tick(monitor);

    monitor.noteActivity();

    expect(handlers.onWarningCancelled).toHaveBeenCalledTimes(1);
    expect(monitor.isPrompting()).toBe(false);
  });

  it('transitions the warning into the durable idle prompt at the deadline', async () => {
    state.warning = 3;
    state.idleSeconds = 7;
    const { handlers, monitor } = setup();
    await tick(monitor);

    vi.setSystemTime(Date.now() + 3000);
    state.idleSeconds = 10;
    await tick(monitor);

    expect(handlers.onIdle).toHaveBeenCalledTimes(1);
    expect(monitor.isPrompting()).toBe(true);
  });

  it('retries presenting a paused idle prompt after a coordinator conflict', async () => {
    state.idleSeconds = 10;
    const { handlers, monitor } = setup();
    handlers.onIdle.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await tick(monitor);
    state.paused = true;
    await tick(monitor);

    expect(handlers.onIdle).toHaveBeenCalledTimes(2);
    expect(monitor.isPrompting()).toBe(true);
  });

  it('never warns or pauses when the timer is not accruing', async () => {
    state.warning = 3;
    state.idleSeconds = 20;
    state.paused = true;
    const { handlers, monitor } = setup();

    await tick(monitor);

    expect(handlers.onWarning).not.toHaveBeenCalled();
    expect(handlers.onIdle).not.toHaveBeenCalled();
  });

  it('clears a warning while machine-away handling is active', async () => {
    state.warning = 3;
    state.idleSeconds = 7;
    const { handlers, monitor } = setup();
    await tick(monitor);

    monitor.suspend();
    await tick(monitor);

    expect(handlers.onWarningCancelled).toHaveBeenCalledTimes(1);
    expect(monitor.isPrompting()).toBe(false);
  });
});
