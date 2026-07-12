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
import type { TimerStatus } from '../../../shared/tracking';
import { HttpError } from '../apiClient';
import type {
  Clock,
  EntryStore,
  IdGen,
  PendingEntrySyncState,
  StartArgs,
  SyncClient,
  TrackingAccrualGuard,
  TimerAwayReason,
  TimerExitReason,
  TimerRecoveryNotice,
  TimerRecoveryResult,
} from './types';

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
    private readonly accrualGuard: TrackingAccrualGuard,
  ) {}

  /**
   * On boot, recover a left-open entry. We only trust time up to
   * `lastKnownActiveAt` (e.g. last heartbeat / last persisted tick), so a crash
   * or power-off never over-credits the offline gap.
   */
  recover(lastKnownActiveAt: number): TimerRecoveryResult | null {
    const open = this.store.getOpen();
    if (!open) {
      this.store.clearExitIntent();
      return null;
    }
    const recoveredAt = safeCloseAt(open, lastKnownActiveAt);
    const recovered = { ...recoverStaleEntry(open, recoveredAt), closeReason: 'AGENT_RECOVERY' as const };
    this.open = null;
    // Persist only; the caller runs flushUnsynced() next, which performs the
    // single sync. Syncing here too would race that flush on the same entry.
    this.store.upsert(recovered);
    this.store.clearExitIntent();
    const notice: TimerRecoveryNotice = {
      entryId: recovered.id,
      recoveredAt,
      reason: 'unexpected_shutdown',
      observedAt: this.clock.now(),
    };
    this.store.setRecoveryNotice(notice);
    return { entryId: recovered.id, recoveredAt, notice };
  }

  recoverAway(): TimerRecoveryResult | null {
    const away = this.store.getAwayState();
    if (!away) return null;

    const notice = this.awayNotice(away.reason, away.entryId, away.awayStartedAt);
    const open = this.store.getOpen();
    if (!open || open.id !== away.entryId) {
      if (!this.store.getRecoveryNotice()) this.store.setRecoveryNotice(notice);
      this.store.clearAwayState();
      return { entryId: away.entryId, recoveredAt: away.awayStartedAt, notice };
    }

    const recoveredAt = safeCloseAt(open, away.awayStartedAt);
    const recovered = { ...recoverStaleEntry(open, recoveredAt), closeReason: 'AGENT_RECOVERY' as const };
    this.open = null;
    this.store.upsert(recovered);
    const recoveredNotice = this.awayNotice(away.reason, recovered.id, recoveredAt);
    this.store.setRecoveryNotice(recoveredNotice);
    this.store.clearAwayState();
    return { entryId: recovered.id, recoveredAt, notice: recoveredNotice };
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
    await this.accrualGuard.assertCanAccrue();
    const now = this.clock.now();
    const nextTaskGuid = args.larkTaskGuid ?? null;
    if (this.open) {
      if ((this.open.larkTaskGuid ?? null) === nextTaskGuid) return this.status();
      const closed = closeTimeEntry(this.open, now);
      this.open = null;
      await this.persistAndSync(closed);
    }
    const entry = this.createEntry(nextTaskGuid, now);
    this.open = entry;
    await this.persistAndSync(entry, 'pending_create');
    return this.status();
  }

  async stop(): Promise<TimerStatus> {
    if (!this.open) return this.status();
    const closed = closeTimeEntry(this.open, safeCloseAt(this.open, this.clock.now()));
    this.open = null;
    await this.persistAndSync(closed);
    return this.status();
  }

  async prepareForQuit(reason: TimerExitReason): Promise<TimerStatus> {
    if (!this.open) {
      this.store.clearExitIntent();
      return this.status();
    }
    const open = this.open;
    const observedAt = this.clock.now();
    this.store.setExitIntent({ reason, entryId: open.id, observedAt });
    const closed = closeTimeEntry(open, safeCloseAt(open, observedAt));
    this.open = null;
    await this.persistAndSync(closed);
    this.store.clearExitIntent();
    return this.status();
  }

  async prepareForAway(reason: TimerAwayReason, awayStartedAt: number): Promise<TimerStatus> {
    if (!this.open) {
      this.store.clearAwayState();
      return this.status();
    }
    const open = this.open;
    const closeAt = safeCloseAt(open, awayStartedAt);
    this.store.setAwayState({ reason, entryId: open.id, awayStartedAt: closeAt, observedAt: this.clock.now() });
    const closed = closeTimeEntry(open, closeAt);
    // The away boundary must exist durably before memory reports the timer as
    // closed. If SQLite rejects the write, keep `open` intact so the power
    // coordinator's one bounded retry can safely attempt the same boundary.
    const nextState = this.store.upsert(closed);
    this.open = null;
    await this.trySync(closed, nextState);
    this.store.setRecoveryNotice(this.awayNotice(reason, closed.id, closeAt));
    this.store.clearAwayState();
    return this.status();
  }

  /** Resume a paused open entry. No-op when idle or already accruing. */
  async resume(): Promise<TimerStatus> {
    if (!this.open) return this.status();
    if (getOpenSegment(this.open)) return this.status();
    await this.resumeFromIdle(this.clock.now());
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
    const paused = { ...closeOpenSegment(this.open, cut), pauseReason: 'IDLE' as const };
    this.open = paused;
    await this.persistAndSync(paused);
  }

  /** Required capture capability disappeared: freeze at the last healthy proof. */
  async pauseForPermission(at: number): Promise<TimerStatus> {
    if (!this.open) return this.status();
    const open = getOpenSegment(this.open);
    if (!open) {
      if (this.open.pauseReason !== 'PERMISSION_REQUIRED') {
        this.open = { ...this.open, revision: this.open.revision + 1, pauseReason: 'PERMISSION_REQUIRED' };
        await this.persistAndSync(this.open);
      }
      return this.status();
    }
    const cut = Math.max(open.startedAt, Math.min(at, this.clock.now()));
    const paused = { ...closeOpenSegment(this.open, cut), pauseReason: 'PERMISSION_REQUIRED' as const };
    this.open = paused;
    await this.persistAndSync(paused);
    return this.status();
  }

  /** Resume from a paused (idle) state: open a fresh WORK segment at `at`. */
  async resumeFromIdle(at: number): Promise<void> {
    if (!this.open) return;
    if (getOpenSegment(this.open)) return; // not paused
    await this.accrualGuard.assertCanAccrue();
    const readyAt = Math.max(at, this.clock.now());
    const resumed = openSegment(this.open, { kind: 'WORK', at: readyAt, segmentId: this.ids.ulid() });
    this.open = resumed;
    await this.persistAndSync(resumed);
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
    await this.accrualGuard.assertCanAccrue();
    const updated = openSegment(this.open, { kind: 'MEETING', at, segmentId: this.ids.ulid() });
    this.open = updated;
    await this.persistAndSync(updated);
  }

  /** Meeting ended: switch back to a WORK segment. No-op if not in MEETING. */
  async endMeeting(at: number): Promise<void> {
    if (!this.open) return;
    const open = getOpenSegment(this.open);
    if (!open || open.kind !== 'MEETING') return;
    await this.accrualGuard.assertCanAccrue();
    const updated = openSegment(this.open, { kind: 'WORK', at, segmentId: this.ids.ulid() });
    this.open = updated;
    await this.persistAndSync(updated);
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
    await this.accrualGuard.assertCanAccrue();
    const updated = applyIdleDiscard(this.open, {
      idleStartedAt: Math.max(awayStart, open.startedAt),
      resumeAt,
      idleSegmentId: this.ids.ulid(),
      workSegmentId: this.ids.ulid(),
    });
    this.open = updated;
    await this.persistAndSync(updated);
  }

  status(): TimerStatus {
    const now = this.clock.now();
    const workedMs = this.workedMsForLocalDay(now);
    if (!this.open) return { state: 'IDLE', workedMs };
    const open = this.open;
    const activeSegment = getOpenSegment(open);
    const firstSeg = open.segments[0]!;
    return {
      state: 'RUNNING',
      entryId: open.id,
      revision: open.revision,
      larkTaskGuid: open.larkTaskGuid ?? null,
      startedAt: firstSeg.startedAt,
      segmentStartedAt: activeSegment?.startedAt ?? null,
      workedMs,
      paused: activeSegment === null,
      pauseReason: activeSegment === null ? open.pauseReason : null,
    };
  }

  /** Entries with any segment active today (newest first), incl. the open one. */
  listToday(now: number): TimeEntry[] {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const since = dayStart.getTime();
    return this.store.listSince(since).filter((e) => e.segments.some((s) => (s.endedAt ?? now) >= since));
  }

  recoveryNotice(): TimerRecoveryNotice | null {
    return this.store.getRecoveryNotice();
  }

  dismissRecoveryNotice(): void {
    this.store.clearRecoveryNotice();
  }

  /** Accept an authoritative non-recoverable server finalization and stop the
   * local timer visibly. Lease-expired entries use normal sync reconciliation
   * instead and never call this path. */
  acceptServerFinalization(entryId: string, endedAt: number): TimerStatus {
    if (!this.open || this.open.id !== entryId) return this.status();
    const boundary = Math.max(this.open.startedAt, endedAt);
    const segments = this.open.segments
      .filter((segment) => segment.startedAt <= boundary)
      .map((segment) => ({
        ...segment,
        endedAt: segment.endedAt === null || segment.endedAt > boundary ? boundary : segment.endedAt,
      }));
    const closed: TimeEntry = {
      ...this.open,
      revision: this.open.revision + 1,
      endedAt: boundary,
      pauseReason: null,
      closeReason: 'AGENT',
      segments,
    };
    this.open = null;
    this.store.upsert(closed);
    this.store.markSynced(closed.id, closed);
    this.store.setRecoveryNotice({
      entryId,
      recoveredAt: boundary,
      reason: 'server_finalized',
      observedAt: this.clock.now(),
    });
    return this.status();
  }

  /** Retry pushing any locally-persisted entries that haven't synced yet. */
  async flushUnsynced(): Promise<void> {
    for (const { entry, syncState } of this.store.getUnsynced()) {
      await this.trySync(entry, syncState);
    }
  }

  /** Activity linked to this entry must wait until its server parent exists. */
  isPendingCreate(entryId: string): boolean {
    return this.store.isPendingCreate(entryId);
  }

  private async persistAndSync(entry: TimeEntry, syncState?: PendingEntrySyncState): Promise<void> {
    const nextState = this.store.upsert(entry, syncState ? { syncState } : undefined);
    await this.trySync(entry, nextState);
  }

  private async trySync(entry: TimeEntry, syncState: PendingEntrySyncState): Promise<void> {
    if (syncState === 'pending_create') {
      await this.tryCreateThenSync(entry);
      return;
    }
    await this.tryUpdate(entry, true);
  }

  private async tryCreateThenSync(entry: TimeEntry): Promise<void> {
    try {
      await this.sync.create(entry);
      this.store.markCreated(entry.id);
    } catch {
      // Best-effort: leave it pending_create; flushUnsynced will retry later.
      return;
    }
    await this.tryUpdate(entry, false);
  }

  private async tryUpdate(entry: TimeEntry, retryCreateOnNotFound: boolean): Promise<void> {
    try {
      await this.sync.sync(entry);
      this.store.markSynced(entry.id, entry);
    } catch (err) {
      if (retryCreateOnNotFound && isNotFound(err)) {
        this.store.markPendingCreate(entry.id);
        await this.tryCreateThenSync(entry);
      }
      // Otherwise best-effort: leave its current pending state for a later flush.
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

  private awayNotice(reason: TimerAwayReason, entryId: string, recoveredAt: number): TimerRecoveryNotice {
    return {
      entryId,
      recoveredAt,
      reason: reason === 'suspend' ? 'sleep_stop' : 'lock_stop',
      observedAt: this.clock.now(),
    };
  }

  private workedMsForLocalDay(now: number): number {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const since = dayStart.getTime();
    const entries = this.store.listSince(since);
    return entries.reduce((sum, entry) => sum + entryWorkedMsInWindow(entry, since, now, now), 0);
  }
}

export type { TimerStatus } from '../../../shared/tracking';

function latestSegmentBoundary(entry: TimeEntry): number {
  return entry.segments.reduce((latest, segment) => {
    const end = segment.endedAt ?? segment.startedAt;
    return Math.max(latest, segment.startedAt, end);
  }, entry.startedAt);
}

function safeCloseAt(entry: TimeEntry, at: number): number {
  return Math.max(at, latestSegmentBoundary(entry));
}

function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
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
