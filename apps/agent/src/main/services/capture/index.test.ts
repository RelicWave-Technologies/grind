import { describe, it, expect } from 'vitest';
import { activityWindowForShot } from './index';

const DAY_DEFAULT = 30 * 60_000;

describe('activityWindowForShot', () => {
  it('first shot (no older) → looks back DEFAULT_WINDOW_MS', () => {
    const t = 10 * 60_000; // 10 minutes
    const w = activityWindowForShot({ capturedAt: t, defaultWindowMs: DAY_DEFAULT });
    expect(w.from).toBe(t - DAY_DEFAULT);
    expect(w.to).toBe(t + 60_000);
  });

  describe('slow cadence (3-hour interval, partition mode)', () => {
    it('starts the window 60s past the older shot', () => {
      const older = 0;
      const now = 3 * 60 * 60_000; // 3h later
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
