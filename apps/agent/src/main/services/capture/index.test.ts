import { describe, it, expect } from 'vitest';
import { activityWindowForShot, previousShotOnSameDisplay } from './index';

const DAY_DEFAULT = 30 * 60_000;

describe('activityWindowForShot', () => {
  it('first shot (no older) → looks back DEFAULT_WINDOW_MS', () => {
    const t = 10 * 60_000; // 10 minutes
    const w = activityWindowForShot({ capturedAt: t, defaultWindowMs: DAY_DEFAULT });
    expect(w.from).toBe(t - DAY_DEFAULT);
    expect(w.to).toBe(t + 60_000);
  });

  describe('normal cadence (1-3 minute interval, partition mode)', () => {
    it('starts the window 60s past the older shot', () => {
      const older = 0;
      const now = 3 * 60_000; // 3m later
      const w = activityWindowForShot({ capturedAt: now, olderCapturedAt: older, defaultWindowMs: DAY_DEFAULT });
      expect(w.from).toBe(older + 60_000);
      expect(w.to).toBe(now + 60_000);
    });
  });

  describe('fast cadence (15-second interval, regression guard)', () => {
    it('REGRESSION: 15s gap must NOT leave a future-only window', () => {
      const older = 60_000_000;          // arbitrary epoch
      const now = older + 15_000;        // 15s later
      const w = activityWindowForShot({ capturedAt: now, olderCapturedAt: older, defaultWindowMs: DAY_DEFAULT });
      // The bug: from = older + 60_000 = now + 45_000 → window [now+45s, now+60s]
      // contained ZERO sample buckets and every bar read 0.
      // The fix: clamp from to at most (now - 60_000) so the past minute is always in scope.
      expect(w.from).toBeLessThanOrEqual(now - 60_000);
      // And the window MUST be long enough to capture at least one minute bucket.
      expect(w.to - w.from).toBeGreaterThanOrEqual(60_000);
    });

    it('30s gap also clamps so the past minute is included', () => {
      const older = 60_000_000;
      const now = older + 30_000;
      const w = activityWindowForShot({ capturedAt: now, olderCapturedAt: older, defaultWindowMs: DAY_DEFAULT });
      expect(w.from).toBe(now - 60_000);
      expect(w.to).toBe(now + 60_000);
    });

    it('exactly-60s gap is the crossover — partition mode kicks in (no clamp needed)', () => {
      const older = 60_000_000;
      const now = older + 60_000;
      const w = activityWindowForShot({ capturedAt: now, olderCapturedAt: older, defaultWindowMs: DAY_DEFAULT });
      // partitionFrom = older + 60_000 = now → which equals (now - 60_000) + 60_000.
      // So min(partitionFrom, now - 60_000) = now - 60_000.
      expect(w.from).toBe(now - 60_000);
    });

    it('5-minute gap is well into partition mode', () => {
      const older = 60_000_000;
      const now = older + 5 * 60_000;
      const w = activityWindowForShot({ capturedAt: now, olderCapturedAt: older, defaultWindowMs: DAY_DEFAULT });
      // partitionFrom = older + 60s; that's earlier than (now - 60s), so it wins.
      expect(w.from).toBe(older + 60_000);
    });
  });
});

describe('previousShotOnSameDisplay', () => {
  it('pairs each shot with the previous shot of its own display, not the other monitor', () => {
    const MIN = 60_000;
    // Two displays captured together every 3 minutes; newest first.
    const rows = [
      { id: 'b2', displayId: 'B', capturedAt: 6 * MIN },
      { id: 'a2', displayId: 'A', capturedAt: 6 * MIN },
      { id: 'b1', displayId: 'B', capturedAt: 3 * MIN },
      { id: 'a1', displayId: 'A', capturedAt: 3 * MIN },
    ];
    const older = previousShotOnSameDisplay(rows, (displayId) => (displayId === 'A' ? 0 : null));
    expect(older.get('a2')).toBe(3 * MIN);
    expect(older.get('b2')).toBe(3 * MIN);
    expect(older.get('a1')).toBe(0); // from before the loaded range
    expect(older.get('b1')).toBeUndefined();

    const w = activityWindowForShot({ capturedAt: 6 * MIN, olderCapturedAt: older.get('b2'), defaultWindowMs: DAY_DEFAULT });
    expect(w).toEqual({ from: 4 * MIN, to: 7 * MIN });
  });
});
