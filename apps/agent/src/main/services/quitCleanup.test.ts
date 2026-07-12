import { describe, expect, it, vi } from 'vitest';
import { QuitCleanupRunner, registerGracefulQuitHandler, type BeforeQuitEventLike } from './quitCleanup';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('QuitCleanupRunner', () => {
  it('finalizes timer, flushes sync, and flushes preferences', async () => {
    const prepareForQuit = vi.fn().mockResolvedValue(undefined);
    const flushUnsynced = vi.fn().mockResolvedValue(undefined);
    const flushPartialActivity = vi.fn();
    const flushPreferences = vi.fn().mockResolvedValue(undefined);
    const runner = new QuitCleanupRunner({
      getTimer: () => ({ prepareForQuit, flushUnsynced }),
      flushPartialActivity,
      flushPreferences,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await runner.run('quit');

    expect(flushPartialActivity).toHaveBeenCalledTimes(1);
    expect(prepareForQuit).toHaveBeenCalledWith('quit');
    expect(flushUnsynced).toHaveBeenCalledTimes(1);
    expect(flushPreferences).toHaveBeenCalledTimes(1);
    expect(runner.hasCompleted()).toBe(true);
  });

  it('reuses the in-flight cleanup for repeated quit attempts', async () => {
    const pending = deferred();
    const prepareForQuit = vi.fn().mockReturnValue(pending.promise);
    const runner = new QuitCleanupRunner({
      getTimer: () => ({ prepareForQuit, flushUnsynced: vi.fn().mockResolvedValue(undefined) }),
      flushPartialActivity: vi.fn(),
      flushPreferences: vi.fn(),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    const first = runner.run('quit');
    const second = runner.run('shutdown');
    expect(first).toBe(second);
    expect(prepareForQuit).toHaveBeenCalledTimes(1);

    pending.resolve();
    await first;
  });

  it('keeps going when timer cleanup fails', async () => {
    const flushPreferences = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const runner = new QuitCleanupRunner({
      getTimer: () => ({
        prepareForQuit: vi.fn().mockRejectedValue(new Error('db busy')),
        flushUnsynced: vi.fn().mockResolvedValue(undefined),
      }),
      flushPartialActivity: vi.fn(),
      flushPreferences,
      logger: { debug: vi.fn(), warn },
    });

    await runner.run('quit');

    expect(flushPreferences).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('quit cleanup timer failed', expect.objectContaining({ reason: 'quit' }));
    expect(runner.hasCompleted()).toBe(true);
  });

  it('can invalidate an early cleanup when the quit-triggering action is cancelled', async () => {
    const runner = new QuitCleanupRunner({
      getTimer: () => ({
        prepareForQuit: vi.fn().mockResolvedValue(undefined),
        flushUnsynced: vi.fn().mockResolvedValue(undefined),
      }),
      flushPartialActivity: vi.fn(),
      flushPreferences: vi.fn(),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await runner.run('quit');
    runner.invalidate();

    expect(runner.hasCompleted()).toBe(false);
  });
});

describe('registerGracefulQuitHandler', () => {
  it('prevents quit until cleanup finishes, then quits again', async () => {
    const listeners = new Map<string, (event: BeforeQuitEventLike) => void>();
    const app = {
      on: vi.fn((event: 'before-quit', listener: (event: BeforeQuitEventLike) => void) => {
        listeners.set(event, listener);
      }),
      quit: vi.fn(),
    };
    const cleanup = deferred();
    const runCleanup = vi.fn().mockReturnValue(cleanup.promise);
    const preventDefault = vi.fn();

    registerGracefulQuitHandler({
      app,
      runCleanup,
      hasCleanupCompleted: () => false,
      markQuitting: vi.fn(),
    });
    listeners.get('before-quit')!({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(runCleanup).toHaveBeenCalledWith('quit');
    cleanup.resolve();
    await cleanup.promise;
    await Promise.resolve();
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('allows quit after cleanup has already completed', () => {
    const listeners = new Map<string, (event: BeforeQuitEventLike) => void>();
    const app = {
      on: vi.fn((event: 'before-quit', listener: (event: BeforeQuitEventLike) => void) => {
        listeners.set(event, listener);
      }),
      quit: vi.fn(),
    };
    const preventDefault = vi.fn();

    registerGracefulQuitHandler({
      app,
      runCleanup: vi.fn(),
      hasCleanupCompleted: () => true,
    });
    listeners.get('before-quit')!({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });
});
