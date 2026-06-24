import {
  COUNTED_KINDS,
  applyIdleDiscard,
  closeOpenSegment,
  closeTimeEntry,
  createTimeEntry,
  getOpenSegment,
  openSegment,
  recoverStaleEntry,
  type TimeEntry,
} from '@grind/core';
import type { Clock, EntryStore, IdGen, StartArgs, SyncClient } from './types';

export type TimerStatus =
  | { state: 'IDLE'; workedMs: number }
  | {
      state: 'RUNNING';
      entryId: string;
      larkTaskGuid: string | null;
      startedAt: number;
      workedMs: number;
      paused: boolean;
    };

/**
 * Orchestrates the local timer using the pure @grind/core segment logic.
 * All side-effecting collaborators (clock, id generation, persistence, network)
 * are injected, so this is fully unit-testable without Electron or SQLite.
 *
 * Sync is best-effort: every mutation persists locally first, then attempts a
 * push. Failures are swallowed here (the entry stays "unsynced" and is retried
 * by `flushUnsynced`), so the timer never blocks on the network.
 */
export class TimerService {
  private open: TimeEntry | null = null;

  constructor(
    private readonly store: EntryStore,
    private readonly sync: SyncClient,
    private readonly clock: Clock,
    private readonly ids: IdGen,
  ) {}

  /**
   * On boot, recover a left-open entry. We only trust time up to
   * `lastKnownActiveAt` (e.g. last heartbeat / last persisted tick), so a crash
   * or power-off never over-credits the offline gap.
   */
  recover(lastKnownActiveAt: number): void {
    const open = this.store.getOpen();
    if (!open) return;
    const recovered = recoverStaleEntry(open, lastKnownActiveAt);
    this.open = null;
    // Persist only; the caller runs flushUnsynced() next, which performs the
    // single sync. Syncing here too would race that flush on the same entry.
    this.store.upsert(recovered);
  }

  isRunning(): boolean {
    return this.open !== null;
  }

  /**
   * Write a "still alive" proof to durable storage. Call periodically while a
   * timer is actively accruing — it bounds crash recovery on the next boot.
   * Cheap (one indexed upsert); safe to call when nothing is open (no-op).
   */
  heartbeat(): void {
    if (!this.open) return;
    this.store.setLiveness(this.clock.now());
  }

  /** Last persisted liveness tick, or null if none. Used by boot recovery. */
  lastLiveness(): number | null {
    return this.store.getLiveness();
  }

  async start(args: StartArgs): Promise<TimerStatus> {
    const now = this.clock.now();
    const nextTaskGuid = args.larkTaskGuid ?? null;
    if (this.open) {
      if ((this.open.larkTaskGuid ?? null) === nextTaskGuid) return this.status();
      const closed = closeTimeEntry(this.open, now);
      this.open = null;
      this.store.upsert(closed);
      await this.trySync(closed, 'sync');
    }
    const entry = this.createEntry(nextTaskGuid, now);
    this.open = entry;
    this.store.upsert(entry);
    await this.trySync(entry, 'create');
    return this.status();
  }

  async stop(): Promise<TimerStatus> {
    if (!this.open) return this.status();
    const closed = closeTimeEntry(this.open, this.clock.now());
    this.open = null;
    this.store.upsert(closed);
    await this.trySync(closed, 'sync');
    return this.status();
  }

  /**
   * Idle detected: PAUSE by closing the open WORK segment at `at` (the moment
   * the user went idle). Worked time freezes there; the idle gap is simply not
   * tracked. The entry stays open (paused) until resume or stop.
   */
  async pauseForIdle(at: number): Promise<void> {
    if (!this.open) return;
    const open = getOpenSegment(this.open);
    if (!open) return; // already paused
    const cut = Math.max(at, open.startedAt); // never before the segment start
    const paused = closeOpenSegment(this.open, cut);
    this.open = paused;
    this.store.upsert(paused);
    await this.trySync(paused, 'sync');
  }

  /** Resume from a paused (idle) state: open a fresh WORK segment at `at`. */
  async resumeFromIdle(at: number): Promise<void> {
    if (!this.open) return;
    if (getOpenSegment(this.open)) return; // not paused
    const resumed = openSegment(this.open, { kind: 'WORK', at, segmentId: this.ids.ulid() });
    this.open = resumed;
    this.store.upsert(resumed);
    await this.trySync(resumed, 'sync');
  }

  /** True when running but paused (entry open, no open segment). */
  isPaused(): boolean {
    return this.open !== null && getOpenSegment(this.open) === null;
  }

  /** Currently in a MEETING segment. */
  isInMeetingSegment(): boolean {
    if (!this.open) return false;
    return getOpenSegment(this.open)?.kind === 'MEETING';
  }

  /** Meeting started: switch the open WORK segment to MEETING. No-op if not
   *  running, paused, or already in a MEETING segment. */
  async beginMeeting(at: number): Promise<void> {
    if (!this.open) return;
    const open = getOpenSegment(this.open);
    if (!open || open.kind === 'MEETING') return;
    const updated = openSegment(this.open, { kind: 'MEETING', at, segmentId: this.ids.ulid() });
    this.open = updated;
    this.store.upsert(updated);
    await this.trySync(updated, 'sync');
  }

  /** Meeting ended: switch back to a WORK segment. No-op if not in MEETING. */
  async endMeeting(at: number): Promise<void> {
    if (!this.open) return;
    const open = getOpenSegment(this.open);
    if (!open || open.kind !== 'MEETING') return;
    const updated = openSegment(this.open, { kind: 'WORK', at, segmentId: this.ids.ulid() });
    this.open = updated;
    this.store.upsert(updated);
    await this.trySync(updated, 'sync');
  }

  /**
   * The machine was away (slept / locked) from `awayStart` until `resumeAt`.
   * If a timer is running, trim that gap so the sleep time is never billed —
   * the open WORK segment ends at `awayStart`, the gap is recorded as
   * IDLE_TRIMMED, and a fresh WORK segment resumes at `resumeAt`.
   * No-op if nothing is running or the gap is trivial (<1s).
   */
  async discardAway(awayStart: number, resumeAt: number): Promise<void> {
    if (!this.open) return;
    if (resumeAt - awayStart < 1000) return;
    const open = getOpenSegment(this.open);
    if (!open) return;
    const updated = applyIdleDiscard(this.open, {
      idleStartedAt: Math.max(awayStart, open.startedAt),
      resumeAt,
      idleSegmentId: this.ids.ulid(),
      workSegmentId: this.ids.ulid(),
    });
    this.open = updated;
    this.store.upsert(updated);
    await this.trySync(updated, 'sync');
  }

  status(): TimerStatus {
    const now = this.clock.now();
    const workedMs = this.workedMsForLocalDay(now);
    if (!this.open) return { state: 'IDLE', workedMs };
    const open = this.open;
    const firstSeg = open.segments[0]!;
    return {
      state: 'RUNNING',
      entryId: open.id,
      larkTaskGuid: open.larkTaskGuid ?? null,
      startedAt: firstSeg.startedAt,
      workedMs,
      paused: getOpenSegment(open) === null,
    };
  }

  /** Entries with any segment active today (newest first), incl. the open one. */
  listToday(now: number): TimeEntry[] {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const since = dayStart.getTime();
    return this.store.listSince(since).filter((e) => e.segments.some((s) => (s.endedAt ?? now) >= since));
  }

  /** Retry pushing any locally-persisted entries that haven't synced yet. */
  async flushUnsynced(): Promise<void> {
    for (const entry of this.store.getUnsynced()) {
      await this.trySync(entry, 'sync');
    }
  }

  private async trySync(entry: TimeEntry, mode: 'create' | 'sync'): Promise<void> {
    try {
      if (mode === 'create') await this.sync.create(entry);
      else await this.sync.sync(entry);
      this.store.markSynced(entry.id);
    } catch {
      // Best-effort: leave it unsynced; flushUnsynced will retry later.
    }
  }

  private createEntry(larkTaskGuid: string | null, startedAt: number): TimeEntry {
    return createTimeEntry({
      id: this.ids.ulid(),
      clientUuid: this.ids.ulid(),
      userId: 'self', // server derives the real userId from the access token
      larkTaskGuid,
      source: 'AUTO',
      startedAt,
      segmentId: this.ids.ulid(),
    });
  }

  private workedMsForLocalDay(now: number): number {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const since = dayStart.getTime();
    const entries = this.store.listSince(since);
    return entries.reduce((sum, entry) => sum + entryWorkedMsInWindow(entry, since, now, now), 0);
  }
}

function entryWorkedMsInWindow(entry: TimeEntry, windowStart: number, windowEnd: number, now: number): number {
  let total = 0;
  for (const segment of entry.segments) {
    if (!COUNTED_KINDS.includes(segment.kind)) continue;
    const start = Math.max(segment.startedAt, windowStart);
    const end = Math.min(segment.endedAt ?? now, windowEnd);
    if (end > start) total += end - start;
  }
  return total;
}
