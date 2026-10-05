import {
  canonicalTimerEntryPayload,
  reconcileTodayLedger,
  closeOpenSegment,
  closeTimeEntry,
  createTimeEntry,
  getOpenSegment,
  openSegment,
  recoverStaleEntry,
  type TimeEntry,
} from '@grind/core';
import { createHash } from 'node:crypto';
import type { TimerSyncReceipt, TodayLedgerMode } from '@grind/types';
import type { TimerStatus } from '../../../shared/tracking';
import { HttpError } from '../apiClient';
import type {
  Clock,
  BusinessDayProvider,
  EntryStore,
  IdGen,
  PendingEntrySyncState,
  StartArgs,
  SyncBacklog,
  SyncClient,
  TrackingAccrualGuard,
  TimerAwayReason,
  TimerExitReason,
  TimerRecoveryNotice,
  TimerRecoveryResult,
  TimerOwner,
  ServerLedgerCache,
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
// One awaited round-trip per entry, so a pass must stay short enough that the
// app is never wedged behind it. The drain re-runs until the backlog is empty.
const FLUSH_BATCH_LIMIT = 25;

/** Wait after the Nth consecutive failure: 30s, 1m, 2m, 4m, 8m, then 15m. */
export function syncRetryDelayMs(failures: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));
}

/** How far back the one-time beta.38 resync looks for server-truncated entries. */
const RESYNC_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

/** Backstop only — correctness comes from `ledgerEpoch`, not from this. */
const LEDGER_MEMO_TTL_MS = 10_000;

export class TimerService {
  private open: TimeEntry | null = null;
  /** Bumped by every durable write; keys the ledger memo. */
  private ledgerEpoch = 0;
  private mutationListener: (() => void) | null = null;
  private readonly backgroundSyncs = new Set<Promise<void>>();
  private todayLedgerMode: TodayLedgerMode = 'OFF';
  /**
   * The entry THIS process opened and has been accruing. An open row read back
   * from disk (a previous run, or another account's session on this machine)
   * never qualifies: its time since the last proof of life is unproven.
   */
  private liveEntryId: string | null = null;

  constructor(
    private readonly store: EntryStore,
    private readonly sync: SyncClient,
    private readonly clock: Clock,
    private readonly ids: IdGen,
    private readonly accrualGuard: TrackingAccrualGuard,
    private readonly businessDay: BusinessDayProvider = UTC_DAY_PROVIDER,
    private readonly serverCache: ServerLedgerCache = EMPTY_SERVER_CACHE,
  ) {}

  bindOwner(owner: TimerOwner | null, claimLegacy = false): void {
    // Switching sessions never rewrites or uploads the previous owner's row.
    // A stranded open row stays owner-bound and is recovered only when that
    // same user signs in again.
    this.store.bindOwner(owner);
    if (owner && claimLegacy) this.store.claimUnownedEntries(owner);
    this.open = this.store.getOpen();
    if (this.open?.id !== this.liveEntryId) this.liveEntryId = null;
  }

  currentOwner(): TimerOwner | null {
    return this.store.currentOwner();
  }

  /**
   * Bind to the signed-in session, closing whatever is left open on either
   * side of an account change.
   *
   * Rebinding used to swap owners and nothing else. User A's open entry stayed
   * open on disk; when A signed in again it was read back as running and the
   * whole time in between — hours of B's session, or the machine switched off
   * — was credited on the next resume or resync. So on any owner change:
   *  - the previous owner's open entry is closed at its last proof of life,
   *    durably and without syncing (A's tokens are gone; the row stays bound
   *    to A and uploads when A signs in again);
   *  - an open entry the new owner left behind is closed the same way, exactly
   *    as boot recovery does.
   * Rebinding the same owner leaves a running timer alone.
   */
  switchOwner(owner: TimerOwner | null, claimLegacy = false): TimerRecoveryResult[] {
    const previous = this.store.currentOwner();
    if (sameOwner(previous, owner)) {
      this.bindOwner(owner, claimLegacy);
      return [];
    }
    const recovered: TimerRecoveryResult[] = [];
    if (previous) {
      const closed = this.recoverAtLastProofOfLife();
      if (closed) recovered.push(closed);
    }
    this.bindOwner(owner, claimLegacy);
    if (owner) {
      const closed = this.recoverAtLastProofOfLife();
      if (closed) recovered.push(closed);
    }
    return recovered;
  }

  /** Close the bound owner's open entry at the last liveness tick written while it accrued. */
  recoverAtLastProofOfLife(): TimerRecoveryResult | null {
    // Falls back to now() only if liveness was never written (very first run).
    return this.recoverAway() ?? this.recover(this.lastLiveness() ?? this.clock.now());
  }

  claimServerMatchedEntries(matches: Array<{ id: string; clientUuid: string }>): number {
    const owner = this.store.currentOwner();
    if (!owner) return 0;
    return this.store.claimServerMatchedEntries(owner, matches);
  }

  setMutationListener(listener: (() => void) | null): void {
    this.mutationListener = listener;
  }

  setTodayLedgerMode(mode: TodayLedgerMode): boolean {
    if (this.todayLedgerMode === mode) return false;
    this.todayLedgerMode = mode;
    return true;
  }

  todayLedgerDiagnostics(now = this.clock.now()): { localMs: number; mergedMs: number; conflicts: number } | null {
    const window = this.businessDay.window(now);
    const owner = this.store.currentOwner();
    if (!window || !owner) return null;
    const local = this.localLedgerEntries(window.start);
    const shared = {
      local,
      activeLocalEntryId: this.open?.id ?? null,
      windowStart: window.start,
      windowEnd: window.end,
      now,
    };
    const localProjection = reconcileTodayLedger({ ...shared, server: [] });
    const mergedProjection = reconcileTodayLedger({
      ...shared,
      server: this.serverCache.list(owner, window.start, window.end, now),
    });
    return {
      localMs: localProjection.workedMs,
      mergedMs: mergedProjection.workedMs,
      conflicts: mergedProjection.conflicts,
    };
  }

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
    // Persist only; the caller runs flushUnsynced() next, which performs the
    // single sync. Syncing here too would race that flush on the same entry.
    this.writeEntry(recovered);
    this.open = null;
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
    this.writeEntry(recovered);
    this.open = null;
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
      const next = this.createEntry(nextTaskGuid, now);
      const [closedState, nextState] = this.store.switchEntry(closed, next);
      this.open = next;
      this.liveEntryId = next.id;
      this.notifyMutation();
      // In order: while the old entry is still open on the server, creating
      // the new one is refused as a second live timer.
      this.syncInBackground([closed, closedState], [next, nextState]);
      return this.status();
    }
    const entry = this.createEntry(nextTaskGuid, now);
    await this.commitOpen(entry, 'pending_create');
    this.liveEntryId = entry.id;
    return this.status();
  }

  async stop(): Promise<TimerStatus> {
    if (!this.open) return this.status();
    const closed = closeTimeEntry(this.open, safeCloseAt(this.open, this.clock.now()));
    await this.commitClosed(closed);
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
    await this.commitClosed(closed);
    this.store.clearExitIntent();
    return this.status();
  }

  async prepareForAway(reason: TimerAwayReason, awayForMs = 0): Promise<TimerStatus> {
    if (!this.open) {
      this.store.clearAwayState();
      return this.status();
    }
    const open = this.open;
    const closeAt = safeCloseAt(open, this.boundaryAgo(awayForMs));
    this.store.setAwayState({ reason, entryId: open.id, awayStartedAt: closeAt, observedAt: this.clock.now() });
    const closed = closeTimeEntry(open, closeAt);
    // The away boundary must exist durably before memory reports the timer as
    // closed. If SQLite rejects the write, keep `open` intact so the power
    // coordinator's one bounded retry can safely attempt the same boundary.
    const nextState = this.writeEntry(closed);
    this.open = null;
    this.store.setRecoveryNotice(this.awayNotice(reason, closed.id, closeAt));
    this.store.clearAwayState();
    this.notifyMutation();
    this.syncInBackground([closed, nextState]);
    return this.status();
  }

  /** Resume a paused open entry. No-op when idle or already accruing. */
  async resume(): Promise<TimerStatus> {
    if (!this.open) return this.status();
    if (getOpenSegment(this.open)) return this.status();
    await this.resumeFromIdle(this.clock.now());
    return this.status();
  }

  /** Explicit user pause: keep the entry/task selected but stop accruing now. */
  async pause(): Promise<TimerStatus> {
    if (!this.open) return this.status();
    const open = getOpenSegment(this.open);
    if (!open) return this.status();
    const paused = { ...closeOpenSegment(this.open, safeCloseAt(this.open, this.clock.now())), pauseReason: 'MANUAL' as const };
    await this.commitOpen(paused);
    return this.status();
  }

  /**
   * Idle detected: PAUSE by closing the open WORK segment at `at` (the moment
   * the user went idle). Worked time freezes there; the idle gap is simply not
   * tracked. The entry stays open (paused) until resume or stop.
   */
  async pauseForIdle(idleForMs: number): Promise<void> {
    if (!this.open) return;
    const open = getOpenSegment(this.open);
    if (!open) return; // already paused
    const cut = Math.max(this.boundaryAgo(idleForMs), open.startedAt);
    const paused = { ...closeOpenSegment(this.open, cut), pauseReason: 'IDLE' as const };
    await this.commitOpen(paused);
  }

  /** Required capture capability disappeared: freeze at the last healthy proof. */
  async pauseForPermission(unhealthyForMs = 0): Promise<TimerStatus> {
    if (!this.open) return this.status();
    const open = getOpenSegment(this.open);
    if (!open) {
      if (this.open.pauseReason !== 'PERMISSION_REQUIRED') {
        const paused = { ...this.open, revision: this.open.revision + 1, pauseReason: 'PERMISSION_REQUIRED' as const };
        await this.commitOpen(paused);
      }
      return this.status();
    }
    const cut = Math.max(open.startedAt, this.boundaryAgo(unhealthyForMs));
    const paused = { ...closeOpenSegment(this.open, cut), pauseReason: 'PERMISSION_REQUIRED' as const };
    await this.commitOpen(paused);
    return this.status();
  }

  /** Resume from a paused (idle) state: open a fresh WORK segment at `at`. */
  async resumeFromIdle(at: number): Promise<void> {
    if (!this.open) return;
    if (getOpenSegment(this.open)) return; // not paused
    await this.accrualGuard.assertCanAccrue();
    const readyAt = Math.max(at, this.clock.now());
    const resumed = openSegment(this.open, { kind: 'WORK', at: readyAt, segmentId: this.ids.ulid() });
    await this.commitOpen(resumed);
  }

  /** True when running but paused (entry open, no open segment). */
  isPaused(): boolean {
    return this.open !== null && getOpenSegment(this.open) === null;
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
    const window = this.businessDay.window(now);
    if (!window) return [];
    return this.todayProjection(now, window).entries.map((item) => item.entry);
  }

  workedMsByTask(now = this.clock.now()): Map<string, number> {
    const window = this.businessDay.window(now);
    if (!window) return new Map();
    const intervals = new Map<string, Array<{ start: number; end: number }>>();
    for (const entry of this.listToday(now)) {
      if (!entry.larkTaskGuid) continue;
      const taskIntervals = intervals.get(entry.larkTaskGuid) ?? [];
      for (const segment of entry.segments) {
        if (segment.kind !== 'WORK' && segment.kind !== 'MEETING') continue;
        const start = Math.max(segment.startedAt, window.start);
        const end = Math.min(segment.endedAt ?? now, window.end);
        if (end > start) taskIntervals.push({ start, end });
      }
      intervals.set(entry.larkTaskGuid, taskIntervals);
    }
    return new Map([...intervals].map(([taskGuid, values]) => [taskGuid, intervalUnionMs(values)]));
  }

  recoveryNotice(): TimerRecoveryNotice | null {
    return this.store.getRecoveryNotice();
  }

  dismissRecoveryNotice(): void {
    this.store.clearRecoveryNotice();
  }

  /**
   * The server's copy of the open entry is missing, behind, or was closed by
   * the server because it stopped hearing from us. Local is the truth: push it.
   * A server close can only be overridden by a newer revision, so when the
   * server already holds ours, bump it.
   *
   * Local is only the truth for time this process actually watched. An entry
   * it did not open is never pushed over the server's close, and one whose last
   * proof of life is older than that close is closed at the proof instead —
   * otherwise a gap nobody tracked (sleep the away handler missed, another
   * account's session) would be re-credited by the resend.
   *
   * @param check.serverEndedAt where the server closed it, when it did.
   * @param check.provenAliveAt the liveness tick as it stood BEFORE this
   *   heartbeat wrote a fresh one.
   */
  async resyncFromServer(
    entryId: string,
    serverRevision: number | null,
    check: { serverEndedAt?: number | null; provenAliveAt?: number | null } = {},
  ): Promise<void> {
    const open = this.open;
    if (!open || open.id !== entryId) return;
    if (open.id !== this.liveEntryId) return;
    const { serverEndedAt = null, provenAliveAt = null } = check;
    if (
      getOpenSegment(open)
      && serverEndedAt !== null
      && provenAliveAt !== null
      && provenAliveAt < serverEndedAt
    ) {
      this.recover(provenAliveAt);
      return;
    }
    if (serverRevision === null) {
      this.store.requeue(entryId, 'pending_create');
      return;
    }
    if (serverRevision >= open.revision) {
      await this.commitOpen({ ...open, revision: serverRevision + 1 });
      return;
    }
    this.store.requeue(entryId, 'pending_update');
  }

  /**
   * The server will not take this entry back — another live timer owns the
   * user (a second device), or it was closed on purpose — so stop visibly at
   * the server's boundary. A close for silence goes through resyncFromServer
   * instead and loses nothing.
   */
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
    this.writeEntry(closed);
    this.open = null;
    this.store.setRecoveryNotice({
      entryId,
      recoveredAt: boundary,
      reason: 'server_finalized',
      observedAt: this.clock.now(),
    });
    this.notifyMutation();
    return this.status();
  }

  /** Retry pushing any locally-persisted entries that haven't synced yet. */
  /**
   * Push pending entries to the server, oldest first.
   *
   * Bounded per call. Each entry costs one awaited round-trip, so an unbounded
   * pass over a large backlog (a spell offline, or the signed-out window where
   * nothing could upload) ran for minutes with no yield. The drain calls this
   * again on its next tick, so the backlog still clears — it just stops being
   * one long uninterruptible stretch.
   *
   * @returns true when entries remain, so a caller can drain again promptly.
   */
  async flushUnsynced(limit = FLUSH_BATCH_LIMIT): Promise<boolean> {
    if (this.backgroundSyncs.size > 0) {
      await Promise.allSettled([...this.backgroundSyncs]);
    }
    let flushed = 0;
    for (const { entry, syncState, attempts } of this.store.getUnsynced(this.clock.now())) {
      // Hitting the batch limit is the ONLY reason to ask for another pass.
      //
      // This used to end with `return this.store.hasUnsynced()`, which is a
      // different question: it is true whenever ANY row is still pending, and
      // the entry currently being tracked is pending by definition — every
      // checkpoint marks it dirty again. The drain treats `true` as "come
      // straight back", so a running timer put it in a permanent loop
      // (6,440 passes in 68 minutes in one field log) which held the in-flight
      // slot and made every scheduled drain a no-op.
      //
      // A row still pending after we tried it is pending because the server
      // would not take it, or because it is the live entry. Neither is fixed by
      // retrying immediately; the interval will come back for it.
      if (flushed >= limit) return true;
      await this.trySync(entry, syncState, attempts);
      flushed += 1;
    }
    return false;
  }

  hasUnsynced(): boolean {
    return this.store.hasUnsynced();
  }

  syncBacklog(): SyncBacklog {
    return this.store.syncBacklog();
  }

  /**
   * One-time repair for agents before beta.38. They accepted a server close
   * for silence as final, so a closed entry can sit "synced" locally while the
   * server holds a shorter copy. Re-send every recent closed entry whose local
   * copy no longer matches what the server acknowledged; the server applies a
   * newer revision over its own close. Entries this agent closed by recovery
   * are skipped: their local end is a guess that may be shorter than the
   * server's proven one.
   */
  resyncTruncatedOnce(): number {
    if (!this.store.markOnce('resync_server_truncated_v38')) return 0;
    let resent = 0;
    const since = this.clock.now() - RESYNC_LOOKBACK_MS;
    for (const row of this.store.listLedgerEntries(since)) {
      const { entry } = row;
      if (row.syncState !== 'synced' || entry.endedAt === null || entry.source !== 'AUTO') continue;
      if (entry.closeReason !== 'AGENT') continue;
      if (row.acknowledgedHash !== null && row.acknowledgedHash === this.hashWithTask(entry, entry.larkTaskGuid ?? null)) continue;
      this.writeEntry({ ...entry, revision: Math.max(entry.revision, row.acknowledgedRevision ?? 0) + 1 });
      resent += 1;
    }
    return resent;
  }

  /** Activity linked to this entry must wait until its server parent exists. */
  isPendingCreate(entryId: string): boolean {
    return this.store.isPendingCreate(entryId);
  }

  private async commitOpen(entry: TimeEntry, syncState?: PendingEntrySyncState): Promise<void> {
    const nextState = this.writeEntry(entry, syncState ? { syncState } : undefined);
    this.open = entry;
    this.notifyMutation();
    this.syncInBackground([entry, nextState]);
  }

  private async commitClosed(entry: TimeEntry): Promise<void> {
    const nextState = this.writeEntry(entry);
    this.open = null;
    this.notifyMutation();
    this.syncInBackground([entry, nextState]);
  }

  /** Push now, in order, without making the caller wait on the network. */
  private syncInBackground(...items: Array<[TimeEntry, PendingEntrySyncState]>): void {
    const pending = (async () => {
      for (const [entry, syncState] of items) await this.trySync(entry, syncState, 0);
    })().finally(() => {
      this.backgroundSyncs.delete(pending);
    });
    this.backgroundSyncs.add(pending);
  }

  /**
   * One push attempt. Never throws: a row the server did not acknowledge is
   * recorded with its error and held back for a while, so the drain moves on
   * to the rest and support can see why it is stuck.
   */
  private async trySync(entry: TimeEntry, syncState: PendingEntrySyncState, attempts: number): Promise<void> {
    let error: string | null;
    try {
      const settled = syncState === 'pending_create'
        ? await this.createThenUpdate(entry)
        : await this.update(entry, true);
      error = settled ? null : 'unacknowledged_receipt';
    } catch (err) {
      error = describeSyncError(err);
    }
    if (error === null) return;
    try {
      this.store.noteSyncFailure(entry.id, error, this.clock.now() + syncRetryDelayMs(attempts + 1));
    } catch {
      // Bookkeeping only; the row stays pending either way.
    }
  }

  /** @returns false when the server answered but did not acknowledge this snapshot. */
  private async createThenUpdate(entry: TimeEntry): Promise<boolean> {
    const receipt = await this.sync.create(entry);
    if (this.acknowledge(entry, receipt)) return true;
    // A newer local write replaced this snapshot; that write pushes itself.
    if (!this.markEntryCreated(entry.id, entry)) return true;
    return this.update(entry, false);
  }

  private async update(entry: TimeEntry, retryCreateOnNotFound: boolean): Promise<boolean> {
    try {
      return this.acknowledge(entry, await this.sync.sync(entry));
    } catch (err) {
      if (!retryCreateOnNotFound || !isNotFound(err)) throw err;
      if (!this.markEntryPendingCreate(entry.id, entry)) return true;
      return this.createThenUpdate(entry);
    }
  }

  /**
   * Turn "it happened N ms ago" into an instant in THIS module's frame.
   *
   * Callers must never hand in an instant. The timer keeps time on the
   * server-aligned clock while its callers read the device clock, and an instant
   * is meaningless without knowing which of the two produced it. On a machine a
   * few minutes out those two frames are not comparable, and `Math.max(at,
   * segment.startedAt)` — the guard meant to stop a boundary preceding its own
   * segment — silently collapses the segment to zero length instead. The server
   * then drops it and rejects the entry as invalid_segments, forever.
   *
   * A duration has no frame. `now - elapsed`, computed here, always lands in the
   * same frame as the segment it is closing.
   */
  private boundaryAgo(elapsedMs: number): number {
    const now = this.clock.now();
    return now - Math.max(0, elapsedMs);
  }

  private createEntry(larkTaskGuid: string | null, startedAt: number): TimeEntry {
    const owner = this.store.currentOwner();
    if (!owner) throw new Error('timer_owner_unavailable');
    return createTimeEntry({
      id: this.ids.ulid(),
      clientUuid: this.ids.ulid(),
      userId: owner.userId,
      larkTaskGuid,
      source: 'AUTO',
      startedAt,
      segmentId: this.ids.ulid(),
    });
  }

  /**
   * @returns true when this snapshot is settled: acknowledged, or superseded
   * by a newer local write that will push itself.
   */
  private acknowledge(entry: TimeEntry, receipt: TimerSyncReceipt): boolean {
    // Task attribution can be edited on the dashboard and is never pushed, so
    // compare against the server's — it is metadata, not tracked time.
    const localHash = this.hashWithTask(entry, receipt.canonicalEntry.larkTaskGuid);
    const exact = receipt.acceptedRevision === entry.revision && receipt.canonicalHash === localHash;
    if (!exact && receipt.disposition === 'FINALIZED' && isServerClosedForSilence(receipt)) {
      // The server closed this entry because it stopped hearing from us and
      // never learned the real end. Accepting that would lose the difference
      // for good. Re-send with a newer revision, which the server applies over
      // its own close; if it already refused a newer one, back off instead.
      if (entry.revision > receipt.acceptedRevision) return false;
      // Only from the snapshot we hold; a newer local write pushes itself.
      const isOpen = this.open?.id === entry.id;
      if (isOpen && JSON.stringify(this.open) !== JSON.stringify(entry)) return true;
      const resent = { ...entry, revision: receipt.acceptedRevision + 1 };
      this.writeEntry(resent);
      if (isOpen) this.open = resent;
      return true;
    }
    const corrected = receipt.acceptedRevision >= entry.revision
      && (receipt.correction !== null || receipt.disposition === 'FINALIZED' || receipt.disposition === 'STALE');
    if (!exact && !corrected) return false;
    const marked = this.markEntrySynced(entry.id, entry, {
      revision: receipt.acceptedRevision,
      hash: receipt.canonicalHash,
    });
    if (marked && receipt.correction === 'CLOCK_CLAMP') {
      const correctedAt = new Date(receipt.canonicalEntry.endedAt ?? receipt.serverTime).getTime();
      this.store.setRecoveryNotice({
        entryId: entry.id,
        recoveredAt: Number.isFinite(correctedAt) ? correctedAt : this.clock.now(),
        reason: 'server_clock_corrected',
        observedAt: this.clock.now(),
      });
    }
    return marked;
  }

  private hashWithTask(entry: TimeEntry, larkTaskGuid: string | null): string {
    return createHash('sha256').update(canonicalTimerEntryPayload({ ...entry, larkTaskGuid })).digest('hex');
  }

  private notifyMutation(): void {
    try {
      this.mutationListener?.();
    } catch {
      // Hydration is advisory; a committed timer mutation must stay successful.
    }
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
    const window = this.businessDay.window(now);
    if (!window) return 0;
    return this.todayProjection(now, window).workedMs;
  }

  private todayProjection(now: number, window: { start: number; end: number }) {
    const owner = this.store.currentOwner();
    const local = this.localLedgerEntries(window.start);
    const server = owner && this.todayLedgerMode === 'VISIBLE'
      ? this.serverCache.list(owner, window.start, window.end, now)
      : [];
    return reconcileTodayLedger({
      local,
      server,
      activeLocalEntryId: this.open?.id ?? null,
      windowStart: window.start,
      windowEnd: window.end,
      now,
    });
  }

  /**
   * The day's ledger rows, memoised.
   *
   * ONLY the read is memoised — never a computed total. `reconcileTodayLedger`
   * still runs on every call with the current `now`, so `workedMs` is
   * bit-identical to what it was before this cache existed. That matters:
   * the projection unions overlapping intervals, so worked time is NOT
   * separable into "static plus live" and must not be accumulated.
   *
   * The open entry's row is safe to hold, because it does not change as time
   * passes — its last segment has `endedAt: null` and the accrual comes from
   * `now` at reconcile time, not from the row.
   *
   * Correctness rests on `ledgerEpoch`, which every durable write bumps via the
   * wrappers below. The TTL is only a backstop: if a future write ever slipped
   * past a wrapper, the memo self-heals within it rather than drifting, because
   * this is a memo of a pure read and never an accumulator.
   */
  private ledgerMemo: { epoch: number; windowStart: number; readAt: number; rows: ReturnType<TimerService['readLedgerEntries']> } | null = null;

  private localLedgerEntries(windowStart: number) {
    const memo = this.ledgerMemo;
    if (
      memo
      && memo.epoch === this.ledgerEpoch
      && memo.windowStart === windowStart
      && this.clock.now() - memo.readAt < LEDGER_MEMO_TTL_MS
    ) {
      return memo.rows;
    }
    const rows = this.readLedgerEntries(windowStart);
    this.ledgerMemo = { epoch: this.ledgerEpoch, windowStart, readAt: this.clock.now(), rows };
    return rows;
  }

  /** Every durable entry write goes through these, so the memo cannot go stale
   *  by someone forgetting to invalidate it. */
  private writeEntry(entry: TimeEntry, opts?: { syncState?: PendingEntrySyncState }) {
    this.ledgerEpoch += 1;
    return this.store.upsert(entry, opts);
  }

  private markEntryCreated(id: string, entry: TimeEntry) {
    this.ledgerEpoch += 1;
    return this.store.markCreated(id, entry);
  }

  private markEntryPendingCreate(id: string, entry: TimeEntry) {
    this.ledgerEpoch += 1;
    return this.store.markPendingCreate(id, entry);
  }

  private markEntrySynced(id: string, entry: TimeEntry, opts: Parameters<EntryStore['markSynced']>[2]) {
    this.ledgerEpoch += 1;
    return this.store.markSynced(id, entry, opts);
  }

  private readLedgerEntries(windowStart: number) {
    return this.store.listLedgerEntries(windowStart).map((item) => ({
      entry: item.entry,
      syncState: item.syncState,
      acknowledgedRevision: item.acknowledgedRevision,
      acknowledgedHash: item.acknowledgedHash,
    }));
  }
}

export type { TimerStatus } from '../../../shared/tracking';

const UTC_DAY_PROVIDER: BusinessDayProvider = {
  window(now) {
    const date = new Date(now);
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return { start, end: start + 24 * 60 * 60_000 };
  },
};

const EMPTY_SERVER_CACHE: ServerLedgerCache = {
  list: () => [],
};

function intervalUnionMs(values: Array<{ start: number; end: number }>): number {
  values.sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let current: { start: number; end: number } | null = null;
  for (const value of values) {
    if (!current) current = { ...value };
    else if (value.start <= current.end) current.end = Math.max(current.end, value.end);
    else {
      total += current.end - current.start;
      current = { ...value };
    }
  }
  return current ? total + current.end - current.start : total;
}

function sameOwner(a: TimerOwner | null, b: TimerOwner | null): boolean {
  if (!a || !b) return a === b;
  return a.userId === b.userId && a.workspaceId === b.workspaceId;
}

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

function isServerClosedForSilence(receipt: TimerSyncReceipt): boolean {
  const reason = receipt.canonicalEntry.closeReason;
  return reason === 'LEASE_EXPIRED' || reason === 'SUPERSEDED';
}

/** Short, stable reason for the heartbeat diagnostics, e.g. `http_409:timer_conflict`. */
function describeSyncError(err: unknown): string {
  if (err instanceof HttpError) {
    let code = '';
    try {
      const body = JSON.parse(err.body) as { error?: unknown };
      if (typeof body.error === 'string') code = `:${body.error}`;
    } catch {
      // Not JSON; the status alone still says enough.
    }
    return `http_${err.status}${code}`;
  }
  return err instanceof Error ? `${err.name}:${err.message}`.slice(0, 200) : 'unknown_error';
}
