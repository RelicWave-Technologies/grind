import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ idleSeconds: 0, running: true, threshold: 10 }));

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => state.idleSeconds } }));
vi.mock('../timer', () => ({ getTimerService: () => ({ isRunning: () => state.running }) }));
vi.mock('../agentConfig', () => ({ getIdleThresholdSec: () => state.threshold }));
vi.mock('../../env', () => ({ IDLE_POLL_MS: 1000 }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { IdleMonitor } = await import('./monitor');

// tick() is private; call it directly for deterministic, timer-free assertions.
const tick = (m: InstanceType<typeof IdleMonitor>) => (m as unknown as { tick(): Promise<void> }).tick();

afterEach(() => {
  state.idleSeconds = 0;
  state.running = true;
  state.threshold = 10;
});

describe('IdleMonitor prompt gating', () => {
  it('does not re-prompt while a prompt is open, until resolve()', async () => {
    state.idleSeconds = 20;
    const onPrompt = vi.fn(async () => {});
    const m = new IdleMonitor(onPrompt);

    await tick(m);
    await tick(m);
    expect(onPrompt).toHaveBeenCalledTimes(1); // second tick guarded by `prompting`
    expect(m.isPrompting()).toBe(true);

    m.resolve();
    await tick(m);
    expect(onPrompt).toHaveBeenCalledTimes(2);
  });

  it('resets prompting when onPrompt fails, so a later idle can prompt again (#7)', async () => {
    state.idleSeconds = 20;
    let calls = 0;
    const onPrompt = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('showIdlePrompt failed');
    });
    const m = new IdleMonitor(onPrompt);

    await tick(m); // first attempt throws → must NOT wedge the flag
    expect(m.isPrompting()).toBe(false);

    await tick(m); // retries because the flag was reset
    expect(onPrompt).toHaveBeenCalledTimes(2);
    expect(m.isPrompting()).toBe(true); // second succeeded → stays open until resolve()
  });

  it('never prompts when the timer is not running', async () => {
    state.idleSeconds = 20;
    state.running = false;
    const onPrompt = vi.fn(async () => {});
    const m = new IdleMonitor(onPrompt);

    await tick(m);
    expect(onPrompt).not.toHaveBeenCalled();
  });
});
