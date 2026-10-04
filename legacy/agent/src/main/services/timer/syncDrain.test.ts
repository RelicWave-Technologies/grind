import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CHAINED_DRAIN_PASSES, TimerSyncDrain } from './syncDrain';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TimerSyncDrain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('interval calls flushUnsynced', async () => {
    const flushUnsynced = vi.fn().mockResolvedValue(undefined);
    const drain = new TimerSyncDrain({ timer: { flushUnsynced }, isOnline: () => true, intervalMs: 1000 });

    drain.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(flushUnsynced).toHaveBeenCalledTimes(1);
    drain.stop();
  });

  it('does not run overlapping drains', async () => {
    const pending = deferred();
    const flushUnsynced = vi.fn().mockReturnValue(pending.promise);
    const drain = new TimerSyncDrain({ timer: { flushUnsynced }, isOnline: () => true, intervalMs: 1000 });

    const first = drain.drainNow('manual');
    const second = drain.drainNow('heartbeat');

    expect(flushUnsynced).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    pending.resolve();
    await first;
  });

  it('skips scheduled interval drains when definitely offline', async () => {
    const flushUnsynced = vi.fn().mockResolvedValue(undefined);
    const drain = new TimerSyncDrain({ timer: { flushUnsynced }, isOnline: () => false, intervalMs: 1000 });

    drain.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(flushUnsynced).not.toHaveBeenCalled();
    drain.stop();
  });

  it('runs immediate drains when online status is true', async () => {
    const flushUnsynced = vi.fn().mockResolvedValue(undefined);
    const drain = new TimerSyncDrain({ timer: { flushUnsynced }, isOnline: () => true });

    await drain.drainNow('auth');

    expect(flushUnsynced).toHaveBeenCalledTimes(1);
  });

  it('runs immediate drains when online status is unknown', async () => {
    const flushUnsynced = vi.fn().mockResolvedValue(undefined);
    const drain = new TimerSyncDrain({
      timer: { flushUnsynced },
      isOnline: () => {
        throw new Error('unknown');
      },
    });

    await drain.drainNow('wake');

    expect(flushUnsynced).toHaveBeenCalledTimes(1);
  });

  it('swallows flush failures so future retries can run', async () => {
    const flushUnsynced = vi.fn().mockRejectedValueOnce(new Error('db busy')).mockResolvedValueOnce(undefined);
    const drain = new TimerSyncDrain({ timer: { flushUnsynced }, isOnline: () => true });

    await drain.drainNow('manual');
    await drain.drainNow('heartbeat');

    expect(flushUnsynced).toHaveBeenCalledTimes(2);
  });

  it('keeps draining while the backlog reports more work', async () => {
    // flushUnsynced is bounded per call so a long backlog cannot wedge the app.
    // The drain must therefore keep going instead of waiting a whole interval.
    const flushUnsynced = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const drain = new TimerSyncDrain({ timer: { flushUnsynced }, isOnline: () => true, intervalMs: 60_000 });

    await drain.drainNow('boot');
    // The interval is never started here, so this only drives the continuation.
    await vi.runAllTimersAsync();

    expect(flushUnsynced).toHaveBeenCalledTimes(3);
    drain.stop();
  });

  it('stops after a pass that reports an empty backlog', async () => {
    const flushUnsynced = vi.fn().mockResolvedValue(false);
    const drain = new TimerSyncDrain({ timer: { flushUnsynced }, isOnline: () => true, intervalMs: 60_000 });

    await drain.drainNow('boot');
    await vi.runAllTimersAsync();

    expect(flushUnsynced).toHaveBeenCalledTimes(1);
    drain.stop();
  });

  it('gives up chaining when the backlog never reports itself empty', async () => {
    // The field failure: flushUnsynced answered "more remaining" on every pass,
    // so the chain never ended. 6,440 passes in 68 minutes, and because each
    // one held the in-flight slot, 280 scheduled drains were dropped as
    // "already running". A backlog that will not clear must decay into the
    // interval, not spin.
    const flushUnsynced = vi.fn().mockResolvedValue(true);
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const drain = new TimerSyncDrain({
      timer: { flushUnsynced }, isOnline: () => true, intervalMs: 60_000, logger,
    });

    await drain.drainNow('boot');
    await vi.runAllTimersAsync();

    expect(flushUnsynced).toHaveBeenCalledTimes(MAX_CHAINED_DRAIN_PASSES);
    expect(logger.warn).toHaveBeenCalledWith(
      'timer sync drain still reports a backlog; leaving it to the interval',
      expect.objectContaining({ passes: MAX_CHAINED_DRAIN_PASSES }),
    );
    drain.stop();
  });

  it('leaves the in-flight slot free once chaining stops', async () => {
    // Starving the scheduled drains is what actually lost the time, so assert
    // the slot is reusable rather than just that the chain ended.
    const flushUnsynced = vi.fn().mockResolvedValue(true);
    const drain = new TimerSyncDrain({ timer: { flushUnsynced }, isOnline: () => true, intervalMs: 60_000 });

    await drain.drainNow('boot');
    await vi.runAllTimersAsync();
    const afterChain = flushUnsynced.mock.calls.length;

    await drain.drainNow('heartbeat');

    expect(flushUnsynced).toHaveBeenCalledTimes(afterChain + 1);
    drain.stop();
  });
});
