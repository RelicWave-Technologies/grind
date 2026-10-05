import { describe, expect, it, vi } from 'vitest';
import { runResync, type ResyncDeps } from './resync';

const OWNER = { userId: 'u1', workspaceId: 'w1' };

function deps(over: Partial<ResyncDeps> & { timerPending?: number[]; activityPending?: number[] } = {}) {
  let t = 0;
  const timerPending = [...(over.timerPending ?? [0])];
  const activityPending = [...(over.activityPending ?? [0])];
  const next = (queue: number[]) => (queue.length > 1 ? queue.shift()! : queue[0]!);
  const base: ResyncDeps = {
    owner: () => OWNER,
    timeZone: () => 'Asia/Kolkata',
    timer: {
      resyncRange: vi.fn(() => ({ requeued: 4, openRequeued: true, skippedRecovered: 0 })),
      rangeBacklog: vi.fn(() => ({ pending: next(timerPending), lastErrors: [] })),
    },
    activity: {
      markUnsyncedInRange: vi.fn(() => 120),
      unsyncedInRange: vi.fn(() => next(activityPending)),
    },
    screenshots: {
      requeueRange: vi.fn(() => ({ requeued: 3, uploaded: 40 })),
      rangeSummary: vi.fn(() => ({ pending: 1, uploaded: 42, failed: 0 })),
    },
    kickDrains: vi.fn(),
    device: () => ({ appVersion: '0.0.2-beta.39', os: 'darwin 15.1', arch: 'arm64' }),
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
  return { ...base, ...over } as ResyncDeps;
}

describe('runResync', () => {
  it('resends the range on the workspace calendar and reports counts', async () => {
    const d = deps({ timerPending: [2, 0], activityPending: [60, 0] });

    const result = await runResync({ from: '2026-10-04', to: '2026-10-05', timeZone: 'UTC' }, d);

    // The agent's own workspace timezone wins over the command's snapshot.
    const start = Date.parse('2026-10-03T18:30:00.000Z');
    const end = Date.parse('2026-10-05T18:30:00.000Z');
    expect(d.timer.resyncRange).toHaveBeenCalledWith(start, end);
    expect(d.activity.markUnsyncedInRange).toHaveBeenCalledWith(OWNER, start, end);
    expect(d.screenshots.requeueRange).toHaveBeenCalledWith(OWNER, start, end);
    expect(result).toEqual({
      range: {
        from: '2026-10-04',
        to: '2026-10-05',
        timeZone: 'Asia/Kolkata',
        startAt: '2026-10-03T18:30:00.000Z',
        endAt: '2026-10-05T18:30:00.000Z',
      },
      timer: { requeued: 4, openRequeued: true, skippedRecovered: 0, pendingAfter: 0, lastErrors: [] },
      activity: { requeued: 120, pendingAfter: 0 },
      screenshots: { requeued: 3, uploaded: 42, failed: 0, pendingAfter: 1 },
      appVersion: '0.0.2-beta.39',
      os: 'darwin 15.1',
      arch: 'arm64',
      durationMs: 5_000,
      timedOut: false,
    });
    // Kicked once up front and again after each wait.
    expect(d.kickDrains).toHaveBeenCalledTimes(2);
  });

  it('falls back to the command timezone, then UTC', async () => {
    const d = deps({ timeZone: () => null });
    const result = await runResync({ from: '2026-10-05', to: '2026-10-05', timeZone: 'Asia/Kolkata' }, d);
    expect(result.range.startAt).toBe('2026-10-04T18:30:00.000Z');

    const utc = await runResync({ from: '2026-10-05', to: '2026-10-05' }, deps({ timeZone: () => null }));
    expect(utc.range).toMatchObject({ timeZone: 'UTC', startAt: '2026-10-05T00:00:00.000Z', endAt: '2026-10-06T00:00:00.000Z' });
  });

  it('stops waiting after the bound and says so', async () => {
    const d = deps({ timerPending: [3], waitMs: 20_000, pollMs: 5_000 });

    const result = await runResync({ from: '2026-10-05', to: '2026-10-05' }, d);

    expect(result.timedOut).toBe(true);
    expect(result.timer.pendingAfter).toBe(3);
    expect(d.sleep).toHaveBeenCalledTimes(4);
  });

  it('refuses bad params or a signed-out agent', async () => {
    await expect(runResync({ from: '2026-10-05' }, deps())).rejects.toThrow('invalid_params');
    await expect(runResync({ from: '2026-10-06', to: '2026-10-05' }, deps())).rejects.toThrow('invalid_range');
    await expect(runResync({ from: '2026-10-05', to: '2026-10-05' }, deps({ owner: () => null }))).rejects.toThrow('signed_out');
  });
});
