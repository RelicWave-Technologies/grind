import {
  applyIdleDiscard,
  closeTimeEntry,
  createTimeEntry,
  getOpenSegment,
  recoverStaleEntry,
  totalWorkedMs,
  type TimeEntry,
} from '@grind/core';
import type { Clock, EntryStore, IdGen, StartArgs, SyncClient } from './types';

export type TimerStatus =
  | { state: 'IDLE' }
  | {
      state: 'RUNNING';
      entryId: string;
      projectId: string;
      taskId: string | null;
      startedAt: number;
      workedMs: number;
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
    this.store.upsert(recovered);
    void this.trySync(recovered, 'sync');
  }

  isRunning(): boolean {
    return this.open !== null;
  }

  async start(args: StartArgs): Promise<TimerStatus> {
    if (this.open) {
      throw new Error('timer already running; stop the current entry first');
    }
    const now = this.clock.now();
    const entry = createTimeEntry({
      id: this.ids.ulid(),
      clientUuid: this.ids.ulid(),
      userId: 'self', // server derives the real userId from the access token
      projectId: args.projectId,
      taskId: args.taskId ?? null,
      source: 'AUTO',
      startedAt: now,
      segmentId: this.ids.ulid(),
    });
    this.open = entry;
    this.store.upsert(entry);
    await this.trySync(entry, 'create');
    return this.status();
  }

  async stop(): Promise<TimerStatus> {
    if (!this.open) return { state: 'IDLE' };
    const closed = closeTimeEntry(this.open, this.clock.now());
    this.open = null;
    this.store.upsert(closed);
    await this.trySync(closed, 'sync');
    return { state: 'IDLE' };
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
    if (!this.open) return { state: 'IDLE' };
    const open = this.open;
    const firstSeg = open.segments[0]!;
    return {
      state: 'RUNNING',
      entryId: open.id,
      projectId: open.projectId,
      taskId: open.taskId,
      startedAt: firstSeg.startedAt,
      workedMs: totalWorkedMs(open, this.clock.now()),
    };
  }

  /** Entries with any segment active today (newest first), incl. the open one. */
  listToday(now: number): TimeEntry[] {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const since = dayStart.getTime();
    const recent = this.store.listRecent(50);
    return recent.filter((e) => e.segments.some((s) => (s.endedAt ?? now) >= since));
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
}
