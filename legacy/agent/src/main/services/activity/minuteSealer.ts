import { ActivityAggregator, type ActivitySample } from './aggregator';

/**
 * Per-minute sealing orchestration — the bug-prone bookkeeping around the pure
 * {@link ActivityAggregator}, extracted with NO Electron imports so it's fully
 * unit-testable with a fake clock.
 *
 * Invariants it guarantees (these are the "never bug" contract):
 *
 *  1. **No silent data loss.** Events are only fed in while `recording` is true,
 *     so the aggregator's contents are *by construction* legitimate tracked work.
 *     A sealed non-empty bucket is therefore ALWAYS persisted — we never re-gate
 *     on live timer state at seal time (the old bug: pausing/stopping at the 60s
 *     tick discarded the whole minute you'd just typed).
 *
 *  2. **At-most-once per bucket.** The server upserts by `(userId, bucketStart)`
 *     and OVERWRITES counts, so emitting the same wall-clock minute twice would
 *     clobber the first emit. `lastEmittedBucket` makes re-emission a no-op. This
 *     protects the rare tick/partial-flush race and stop→restart-within-a-minute.
 *
 *  3. **Correct attribution across stop.** A minute is credited to the entry that
 *     was active *while it was captured* (`recordingEntryId`), not whatever the
 *     timer reads at seal time — which is null right after a stop.
 *
 *  4. **Seal-on-exit.** {@link sealPartial} seals the in-flight (sub-minute) bucket
 *     so quitting mid-minute keeps the partial, matching WakaTime/Hubstaff.
 */
export interface MinuteSealerDeps {
  /** Wall clock (ms). Injected so tests can drive time deterministically. */
  now: () => number;
  /**
   * Durably persist a sealed sample. Called at most once per bucketStart.
   * `entryId` is the time-entry active while the minute was captured (may be
   * null only if recording somehow started without an entry).
   */
  persist: (sample: ActivitySample, entryId: string | null) => void;
}

function minuteFloor(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

export class MinuteSealer {
  private agg = new ActivityAggregator();
  private recording = false;
  private recordingEntryId: string | null = null;
  /** The wall-clock minute currently accumulating. */
  private bucketStart: number;
  /** Highest bucket already emitted; guards against double-emit/overwrite. */
  private lastEmittedBucket = -1;

  constructor(private readonly deps: MinuteSealerDeps) {
    this.bucketStart = minuteFloor(deps.now());
  }

  /** Mirror of "timer running & not paused". Stashes the entry for attribution. */
  setRecording(on: boolean, entryId: string | null): void {
    this.recording = on;
    if (on) this.recordingEntryId = entryId;
  }

  // --- Input feed (no-ops unless recording) ---------------------------------
  onKey(ts: number): void {
    if (this.recording) this.agg.onKey(ts);
  }
  onClick(): void {
    if (this.recording) this.agg.onClick();
  }
  onScroll(): void {
    if (this.recording) this.agg.onScroll();
  }
  onMove(ts: number, x: number, y: number): void {
    if (this.recording) this.agg.onMove(ts, x, y);
  }

  /**
   * Called on the ~60s timer. Seals the bucket that just elapsed and advances
   * to the current wall-clock minute. Returns the sealed bucketStart (or null
   * if nothing was emitted) — handy for tests and window pruning.
   */
  tick(): number | null {
    const sealed = this.seal(this.bucketStart);
    this.bucketStart = minuteFloor(this.deps.now());
    return sealed;
  }

  /**
   * Seal the in-flight (partial) minute right now — for app quit / shutdown.
   * Does NOT advance the bucket (the process is exiting). At-most-once still
   * applies, so a tick immediately afterward won't double-count.
   */
  sealPartial(): number | null {
    return this.seal(this.bucketStart);
  }

  private seal(bucket: number): number | null {
    // Already emitted (race / restart-within-minute): drop, don't overwrite.
    if (bucket <= this.lastEmittedBucket) {
      this.agg.flush(bucket); // still reset so stale events don't leak forward
      return null;
    }
    if (this.agg.isEmpty()) {
      this.agg.flush(bucket);
      return null;
    }
    const sample = this.agg.flush(bucket);
    this.lastEmittedBucket = bucket;
    this.deps.persist(sample, this.recordingEntryId);
    return bucket;
  }
}
