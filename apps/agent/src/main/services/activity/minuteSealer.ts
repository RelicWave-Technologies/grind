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
 *  2. **Every tracked minute is a sample.** A minute in which input was being
 *     recorded is persisted even when nothing happened in it — as zeros. Activity
 *     percent is an average over tracked minutes; skipping the quiet ones made a
 *     person who typed for one minute in ten read as 100% active.
 *
 *  3. **Wall-clock buckets.** Events land in the minute they happened in: the
 *     bucket rolls over on the first event, recording update or tick after a
 *     minute boundary, whichever comes first — never on a timer that drifts
 *     against the clock.
 *
 *  4. **Correct attribution across stop.** A minute is credited to the entry that
 *     was active *while it was captured* (`recordingEntryId`), not whatever the
 *     timer reads at seal time — which is null right after a stop.
 *
 *  4b. **Owner stamped at record time.** A minute belongs to the account that
 *     was signed in while it was recorded — captured with `setRecording`, not
 *     read at seal time, when a sign-out or switch may already have happened.
 *     If the account changes mid-minute, what was recorded so far is sealed
 *     for the previous account first.
 *
 *  5. **Seal-on-exit.** {@link sealPartial} seals the in-flight (sub-minute) bucket
 *     so quitting mid-minute keeps the partial, matching WakaTime/Hubstaff. The
 *     same minute sealed again — later in this process, or after a restart within
 *     the minute — is persisted again with only what is new; `persist` adds it
 *     to the minute already stored (see `ActivityStore.persistMinute`), so the
 *     minute is never overwritten by its tail.
 */
/** The account a minute is recorded for (structurally the timer's owner). */
export interface SealOwner {
  userId: string;
  workspaceId: string;
}

function sameSealOwner(a: SealOwner | null, b: SealOwner | null): boolean {
  if (a === null || b === null) return a === b;
  return a.userId === b.userId && a.workspaceId === b.workspaceId;
}

export interface MinuteSealerDeps {
  /** Wall clock (ms). Injected so tests can drive time deterministically. */
  now: () => number;
  /**
   * Durably persist a sealed sample, ADDING it to anything already stored for
   * the same minute. `entryId` is the time-entry active while the minute was
   * captured (may be null only if recording somehow started without an entry).
   */
  persist: (sample: ActivitySample, entryId: string | null, owner: SealOwner | null) => void;
  /**
   * Whether input is actually being observed right now (the OS hook is
   * running). A tracked minute we could not observe is not a zero-activity
   * minute — it is a minute we know nothing about, and is not stored.
   */
  isCapturing?: () => boolean;
}

export function minuteFloor(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000;
}

export class MinuteSealer {
  private agg = new ActivityAggregator();
  private recording = false;
  private recordingEntryId: string | null = null;
  private recordingOwner: SealOwner | null = null;
  /** The wall-clock minute currently accumulating. */
  private bucketStart: number;
  /** Input was recorded (and observable) at some point during the current bucket. */
  private observed = false;

  constructor(private readonly deps: MinuteSealerDeps) {
    this.bucketStart = minuteFloor(deps.now());
  }

  /** Mirror of "timer running & not paused". Stashes the entry and account for attribution. */
  setRecording(on: boolean, entryId: string | null, owner: SealOwner | null = null): void {
    this.roll();
    if (on && !sameSealOwner(owner, this.recordingOwner)) {
      // A different account from here on: what this minute holds so far was
      // recorded for the previous one, so seal it for them now.
      this.seal(this.bucketStart);
      this.recordingOwner = owner ? { userId: owner.userId, workspaceId: owner.workspaceId } : null;
    }
    this.recording = on;
    if (on) this.recordingEntryId = entryId;
    this.noteObserved();
  }

  // --- Input feed (no-ops unless recording) ---------------------------------
  onKey(ts: number): void {
    if (!this.recording) return;
    this.roll();
    this.agg.onKey(ts);
  }
  onClick(): void {
    if (!this.recording) return;
    this.roll();
    this.agg.onClick();
  }
  onScroll(): void {
    if (!this.recording) return;
    this.roll();
    this.agg.onScroll();
  }
  onMove(ts: number, x: number, y: number): void {
    if (!this.recording) return;
    this.roll();
    this.agg.onMove(ts, x, y);
  }

  /**
   * Called just after each minute boundary. Seals the bucket that just elapsed
   * and advances to the current wall-clock minute. Returns the sealed
   * bucketStart (or null if nothing was emitted) — handy for tests and window
   * pruning.
   */
  tick(): number | null {
    try {
      return this.roll();
    } finally {
      // Even if persisting the sealed minute threw, the new one is observed.
      this.noteObserved();
    }
  }

  /**
   * Seal the in-flight (partial) minute right now — for app quit / shutdown.
   * Does NOT advance the bucket (the process is exiting). Anything recorded in
   * the same minute afterwards is persisted on top of it, never over it.
   */
  sealPartial(): number | null {
    return this.seal(this.bucketStart);
  }

  /** Seal the current bucket if the wall clock has moved past it. */
  private roll(): number | null {
    const current = minuteFloor(this.deps.now());
    if (current <= this.bucketStart) return null;
    // Advance first: a persist that throws must not leave the sealer stuck on
    // a minute it already flushed.
    const elapsed = this.bucketStart;
    this.bucketStart = current;
    return this.seal(elapsed);
  }

  private noteObserved(): void {
    if (this.recording && (this.deps.isCapturing?.() ?? true)) this.observed = true;
  }

  private seal(bucket: number): number | null {
    const hadInput = !this.agg.isEmpty();
    const wasObserved = this.observed;
    const sample = this.agg.flush(bucket);
    this.observed = false;
    if (!hadInput && !wasObserved) return null;
    this.deps.persist(sample, this.recordingEntryId, this.recordingOwner);
    return bucket;
  }
}
