import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivitySyncDrain } from './syncDrain';
import type { ActivityStore } from './store';

function deferred() {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ActivitySyncDrain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs periodic drains', async () => {
    const flush = vi.fn().mockResolvedValue(0);
    const drain = new ActivitySyncDrain({
      getStore: () => ({}) as ActivityStore,
      flush,
      intervalMs: 1000,
    });

    drain.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(flush).toHaveBeenCalledTimes(1);
    drain.stop();
  });

  it('drains multiple batches until empty', async () => {
    const flush = vi.fn().mockResolvedValueOnce(200).mockResolvedValueOnce(50).mockResolvedValueOnce(0);
    const drain = new ActivitySyncDrain({ getStore: () => ({}) as ActivityStore, flush });

    const result = await drain.drainNow('boot');

    expect(result).toEqual({ batches: 2, samples: 250, skipped: null });
    expect(flush).toHaveBeenCalledTimes(3);
  });

  it('waits for timer sync before uploading dependent activity', async () => {
    const order: string[] = [];
    const beforeFlush = vi.fn(async () => {
      order.push('timer');
    });
    const flush = vi.fn(async () => {
      order.push('activity');
      return 0;
    });
    const drain = new ActivitySyncDrain({ getStore: () => ({}) as ActivityStore, beforeFlush, flush });

    await drain.drainNow('sample');

    expect(order).toEqual(['timer', 'activity']);
    expect(beforeFlush).toHaveBeenCalledTimes(1);
  });

  it('does not upload activity when its sync prerequisite fails', async () => {
    const flush = vi.fn().mockResolvedValue(0);
    const drain = new ActivitySyncDrain({
      getStore: () => ({}) as ActivityStore,
      beforeFlush: vi.fn().mockRejectedValue(new Error('timer store unavailable')),
      flush,
    });

    expect(await drain.drainNow('wake')).toEqual({ batches: 0, samples: 0, skipped: null });
    expect(flush).not.toHaveBeenCalled();
  });

  it('stops on the first failed batch and leaves later rows for a retry', async () => {
    const flush = vi.fn().mockResolvedValueOnce(200).mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(0);
    const drain = new ActivitySyncDrain({ getStore: () => ({}) as ActivityStore, flush });

    const result = await drain.drainNow('auth');

    expect(result).toEqual({ batches: 1, samples: 200, skipped: null });
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('does not run overlapping drains', async () => {
    const pending = deferred();
    const flush = vi.fn().mockReturnValue(pending.promise);
    const drain = new ActivitySyncDrain({ getStore: () => ({}) as ActivityStore, flush });

    const first = drain.drainNow('sample');
    const second = drain.drainNow('wake');
    await Promise.resolve();

    expect(second).toBe(first);
    expect(flush).toHaveBeenCalledTimes(1);
    pending.resolve(0);
    await first;
  });

  it('throttles heartbeat-triggered drains', async () => {
    let now = 120_000;
    const flush = vi.fn().mockResolvedValue(0);
    const drain = new ActivitySyncDrain({
      getStore: () => ({}) as ActivityStore,
      flush,
      heartbeatThrottleMs: 60_000,
      now: () => now,
    });

    await drain.drainNow('heartbeat');
    const throttled = await drain.drainNow('heartbeat');
    now += 60_000;
    await drain.drainNow('heartbeat');

    expect(throttled).toEqual({ batches: 0, samples: 0, skipped: 'heartbeat-throttle' });
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
