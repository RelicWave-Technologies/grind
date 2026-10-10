import {
  canonicalTimerEntryPayload,
  reconcileTodayLedger,
  subtractIntervals,
  unionMs,
  closeOpenSegment,
  closeTimeEntry,
  createTimeEntry,
  dropZeroLengthSegments,
  getOpenSegment,
  openSegment,
  recoverStaleEntry,
  type TimeEntry,
} from '@grind/core';
import { createHash } from 'node:crypto';
import type { TimerSyncReceipt, TodayLedgerMode } from '@grind/types';
import type { TimerStatus } from '../../../shared/tracking';
import { HttpError } from '../apiClient';
import { isClosedForSilence } from './serverClose';
import type {
  Clock,
  BusinessDayProvider,
  EntryStore,
  IdGen,
  MissedSleep,
  PendingEntrySyncState,
  RangeBacklog,
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

/** A server clock correction smaller than this is not worth a banner. */
export const CLOCK_CORRECTION_NOTICE_MS = 60_000;

/** How far back the one-time beta.38 resync looks for server-truncated entries. */
const RESYNC_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

/** Backstop only — correctness comes from `ledgerEpoch`, not from this. */
const LEDGER_MEMO_TTL_MS = 10_000;

/**
 * Longest silence between two proofs of life that still means "this process
 * was running the whole time".
 *
 * The main loop proves life every second. A gap anywhere near this means the
 * process was not scheduled at all: the machine slept — or Windows Modern
 * Standby froze the process — and the suspend event that would have closed the
 * timer never arrived (on Modern Standby it often does not). The running entry
 * is then closed at the last proof of life before the gap, never across it.
 *
 * 90 seconds because it is:
 *  - far above any stall of a process that is really running: interval jitter,
 *    macOS App Nap timer throttling (seconds), a GC pause, a slow SQLite write;
 *  - below the server's 3-minute lease, so a gap counted here as worked is one
 *    the server would have counted too — the widget and the server agree;
 *  - short enough that Modern Standby's brief maintenance wakes (a few seconds
 *    of running every several minutes) cannot chain proofs of life across the
 *    standby: each wake follows a freeze far longer than this, so its FIRST
 *    proof closes the timer instead of vouching for the gap. Anything shorter
 *    that slips under it is left to idle detection, which backdates to the
 *    last input.
 *
 * A device clock stepped forward by more than this while working looks the
 * same and is treated the same — the timer stops and offers to resume. That
 * is the safe direction: it can cost a person a click, never bill a gap.
 */
export const MISSED_SLEEP_GAP_MS = 90_000;

/**
 * Persist the liveness tick at most this often while accruing. It bounds crash
 * recovery (a hard power-off is credited at most this much); writing it every
 * second would be one SQLite write per second for no real gain.
 */
export const LIVENESS_PERSIST_EVERY_MS = 15_000;

/** One proof of life, read on every clock the gap check compares. */
interface AliveSample {
  /** Timer frame — where an entry closed for a missed sleep ends. */
  at: number;
  wallMs: number;
  monoMs: number;
}

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
  /** The last proof of life (in memory; see noteAlive). */
  private lastAlive: AliveSample | null = null;
  /** When the liveness tick was last persisted, timer frame. */
  private livenessPersistedAt: number | null = null;
  private missedSleepListener: ((missed: MissedSleep) => void) | null = null;

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

  /**
   * Close the bound owner's open entry at its last proof of life: the quit it
   * was in the middle of (exit intent), else the last persisted liveness tick.
   * With neither, nothing past the entry's own last boundary is credited —
   * never "now", which would bill the whole time the process was dead.
   */
  recoverAtLastProofOfLife(): TimerRecoveryResult | null {
    return this.recoverAway() ?? this.recover(this.lastProofOfLife());
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
      invalidations: this.serverCache.invalidations?.(owner, window.start, window.end) ?? [],
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
   * or power-off never over-credits the offline gap. Null means nothing is
   * proven past the entry's own last boundary.
   */
  recover(lastKnownActiveAt: number | null): TimerRecoveryResult | null {
    const open = this.store.getOpen();
    if (!open) {
      this.store.clearExitIntent();
      return null;
    }
    const recoveredAt = safeCloseAt(open, lastKnownActiveAt ?? Number.NEGATIVE_INFINITY);
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

  /**
   * Boot-time half of prepareForAway's crash safety: an away close that could
   * not be written left its boundary behind, and it beats the liveness tick
   * (the person had already left by then).
   */
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
   * The one proof-of-life entry point: the 1-second main loop, the server
   * heartbeat, a resume/unlock, and Windows' end-of-session query all call it.
   *
   * First it checks how long it has been since the previous proof. A gap over
   * MISSED_SLEEP_GAP_MS is a sleep the OS never reported: the open entry is
   * closed at the previous proof — BEFORE anything new is written, so a brief
   * wake can never vouch for the time asleep — and the missed-sleep listener
   * runs the ordinary "you were away" flow.
   *
   * Otherwise, while accruing, it persists the liveness tick that bounds crash
   * recovery: at most every LIVENESS_PERSIST_EVERY_MS, or now with `persist`.
   *
   * Throws only if the close for a missed sleep cannot be written; the gap is
   * then still there for the next call to find.
   */
  noteAlive(opts: { persist?: boolean } = {}): MissedSleep | null {
    const sample = this.sampleClocks();
    const missed = this.checkForMissedSleep(sample);
    if (missed) return missed;
    if (!this.open || !getOpenSegment(this.open)) return null;
    const due = this.livenessPersistedAt === null
      || sample.at - this.livenessPersistedAt >= LIVENESS_PERSIST_EVERY_MS;
    if (opts.persist || due) this.persistLiveness(sample.at);
    return null;
  }

  setMissedSleepListener(listener: ((missed: MissedSleep) => void) | null): void {
    this.missedSleepListener = listener;
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
      this.persistLiveness(now);
      this.notifyMutation();
      // In order: while the old entry is still open on the server, creating
      // the new one is refused as a second live timer.
      this.syncInBackground([closed, closedState], [next, nextState]);
      return this.status();
    }
    const entry = this.createEntry(nextTaskGuid, now);
    await this.commitOpen(entry, 'pending_create');
    this.liveEntryId = entry.id;
    // Proven from the first second: a crash before the next tick must recover
    // at this start, never at a stale tick of an older entry or at "now".
    this.persistLiveness(now);
    return this.status();
  }

  async stop(): Promise<TimerStatus> {
    if (!this.open) return this.status();
    const closed = closeTimeEntry(this.open, safeCloseAt(this.open, this.clock.now()));
    await this.commitClosed(closed);
    return this.status();
  }

  async prepareForQuit(reason: TimerExitReason): Promise<TimerStatus> {
    // A quit can be the first thing to run after an unreported sleep (Windows
    // installing an update out of Modern Standby); it must not bill the sleep.
    this.closeOverUnreportedSleep();
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
    // Never past the last proof of life. A lock or suspend event the OS
    // delivers late — after the wake — would otherwise close at wake time and
    // bill the whole sleep.
    const provenUntil = this.lastAlive?.at ?? Number.POSITIVE_INFINITY;
    const closeAt = safeCloseAt(open, Math.min(this.boundaryAgo(awayForMs), provenUntil));
    const closed = closeTimeEntry(open, closeAt);
    // The away boundary must exist durably before memory reports the timer as
    // closed. If SQLite rejects the write, keep `open` intact so the power
    // coordinator's one bounded retry can safely attempt the same boundary.
    let nextState: PendingEntrySyncState;
    try {
      nextState = this.writeEntry(closed);
    } catch (err) {
      // Leave the boundary behind so that if the retry fails too and the
      // process dies, boot recovery closes here (recoverAway) rather than at
      // the later liveness tick. Best effort: the store just failed once.
      try {
        this.store.setAwayState({ reason, entryId: open.id, awayStartedAt: closeAt, observedAt: this.clock.now() });
      } catch {
        // Recovery falls back to the liveness tick.
      }
      throw err;
    }
    this.open = null;
    // A boundary an earlier failed attempt left behind is now written.
    this.store.clearAwayState();
    // No recovery notice: the welcome-back prompt already tells the person,
    // and a notice here overwrote any crash or server notice still unread
    // and left a banner that outlived the prompt.
    this.notifyMutation();
    this.syncInBackground([closed, nextState]);
    return this.status();
  }

  /**
   * Resume a paused open entry with a fresh WORK segment from now. No-op when
   * idle or already accruing.
   */
  async resume(): Promise<TimerStatus> {
    if (!this.open) return this.status();
    if (getOpenSegment(this.open)) return this.status();
    await this.accrualGuard.assertCanAccrue();
    const now = this.clock.now();
    const resumed = openSegment(this.open, { kind: 'WORK', at: now, segmentId: this.ids.ulid() });
    await this.commitOpen(resumed);
    // The tick written before the pause is no proof for this new segment.
    this.persistLiveness(now);
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
    return {
      state: 'RUNNING',
      entryId: open.id,
      revision: open.revision,
      larkTaskGuid: open.larkTaskGuid ?? null,
      // The entry's own start: a pause that landed on the first segment's
      // start removed that segment, so there may be no segment to read.
      startedAt: open.startedAt,
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
    const owner = this.store.currentOwner();
    const invalidated = owner && this.todayLedgerMode === 'VISIBLE'
      ? this.serverCache.invalidations?.(owner, window.start, window.end) ?? []
      : [];
    return new Map([...intervals].map(([taskGuid, values]) => [
      taskGuid,
      unionMs(subtractIntervals(values, invalidated)),
    ]));
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
    // The answer may have sat through a sleep (the request went out, the
    // machine slept, the reply landed after the wake). If so the entry is
    // closed at the sleep's start right here, and below finds nothing open to
    // push — the truncated close goes up through the normal sync instead.
    this.closeOverUnreportedSleep();
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
    // Cut at the boundary; whatever that leaves empty is removed, not kept as
    // a zero-length span (ZERO-LENGTH SEGMENTS in @grind/core segments.ts).
    const { entry: cut } = dropZeroLengthSegments({
      ...this.open,
      segments: this.open.segments
        .filter((segment) => segment.startedAt <= boundary)
        .map((segment) => ({
          ...segment,
          endedAt: segment.endedAt === null || segment.endedAt > boundary ? boundary : segment.endedAt,
        })),
    });
    const segments = cut.segments;
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
    // A drain can be the first thing to run after an unreported sleep. Close
    // over the gap before pushing, or the open entry would go up claiming to
    // be alive across it.
    this.closeOverUnreportedSleep();
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

  /**
   * Developer-requested resend of everything this owner tracked in
   * [startMs, endMs): local is the truth, so put it back on the upload queue
   * and let the drain push it again.
   *
   * - A closed entry the server already has gets a revision above anything the
   *   server acknowledged, so it replaces whatever copy the server holds (the
   *   server applies a newer revision over its own close). One never created
   *   stays a pending create.
   * - The running entry is queued again; its revision is bumped only when this
   *   process has been watching it (see resyncFromServer for why).
   *
   * Backoff is cleared on every row touched, so the next drain sends them all.
   */
  resyncRange(startMs: number, endMs: number): { requeued: number; openRequeued: boolean; skippedRecovered: number } {
    if (!this.store.currentOwner()) throw new Error('timer_owner_unavailable');
    let requeued = 0;
    let openRequeued = false;
    let skippedRecovered = 0;
    for (const row of this.store.listLedgerEntries(startMs)) {
      const { entry } = row;
      if (entry.startedAt >= endMs) continue;
      if (entry.endedAt !== null && entry.endedAt <= startMs) continue;
      const nextRevision = Math.max(entry.revision, row.acknowledgedRevision ?? 0) + 1;
      if (entry.endedAt === null) {
        // Only the entry this service holds open is live; any other open row
        // is closed by recovery on the next owner bind, not resent here.
        if (!this.open || this.open.id !== entry.id) continue;
        if (row.syncState === 'synced' && entry.id === this.liveEntryId) {
          const bumped = { ...this.open, revision: Math.max(this.open.revision, nextRevision) };
          this.writeEntry(bumped);
          this.open = bumped;
        } else {
          this.store.requeue(entry.id, row.syncState === 'pending_create' ? 'pending_create' : 'pending_update');
          this.ledgerEpoch += 1;
        }
        openRequeued = true;
        continue;
      }
      // A crash-recovered entry's end is this agent's estimate (its last
      // liveness); the server may hold a longer, proven copy. Re-sending it with
      // a newer revision would replace that with the shorter guess.
      if (entry.closeReason === 'AGENT_RECOVERY' && row.syncState === 'synced') {
        skippedRecovered += 1;
        continue;
      }
      if (row.syncState === 'pending_create') {
        this.store.requeue(entry.id, 'pending_create');
        this.ledgerEpoch += 1;
      } else {
        this.writeEntry({ ...entry, revision: nextRevision });
      }
      requeued += 1;
    }
    if (requeued > 0 || openRequeued) this.notifyMutation();
    return { requeued, openRequeued, skippedRecovered };
  }

  /** Closed entries in [startMs, endMs) the server has not acknowledged yet. */
  rangeBacklog(startMs: number, endMs: number): RangeBacklog {
    return this.store.rangeBacklog(startMs, endMs);
  }

  /** True the first time `key` is marked for the bound owner. */
  markOnce(key: string): boolean {
    return this.store.markOnce(key);
  }

  getNote(key: string): string | null {
    return this.store.getNote(key);
  }

  setNote(key: string, value: string): void {
    this.store.setNote(key, value);
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

  private sampleClocks(): AliveSample {
    const at = this.clock.now();
    return { at, wallMs: this.clock.wallNow?.() ?? at, monoMs: this.clock.monoNow?.() ?? at };
  }

  /** noteAlive's gap check alone, for paths that must not fail on it (sync, quit). */
  private closeOverUnreportedSleep(): void {
    try {
      this.checkForMissedSleep(this.sampleClocks());
    } catch {
      // The close could not be written; the gap stays for the next tick.
    }
  }

  /**
   * Record `sample` as the latest proof of life. When the gap since the
   * previous one is a sleep nobody reported, first close the open entry at the
   * previous proof and tell the listener.
   */
  private checkForMissedSleep(sample: AliveSample): MissedSleep | null {
    const previous = this.lastAlive;
    // The larger of the two: the wall clock catches a real sleep (a monotonic
    // source stops during it on macOS), the monotonic one a frozen process
    // whose wall clock was set back meanwhile.
    const gapMs = previous
      ? Math.max(sample.wallMs - previous.wallMs, sample.monoMs - previous.monoMs)
      : 0;
    if (!previous || gapMs <= MISSED_SLEEP_GAP_MS) {
      this.lastAlive = sample;
      return null;
    }
    // Throws if the close cannot be written, leaving `lastAlive` where it was
    // so the next proof still sees the gap.
    const missed = this.closeForMissedSleep(previous, gapMs);
    this.lastAlive = sample;
    try {
      this.missedSleepListener?.(missed);
    } catch {
      // The close is durable; the prompt is the listener's business.
    }
    return missed;
  }

  private persistLiveness(at: number): void {
    this.store.setLiveness(at);
    this.livenessPersistedAt = at;
  }

  /** The latest instant the open entry was proven alive, for boot recovery. */
  private lastProofOfLife(): number | null {
    const open = this.store.getOpen();
    const intent = this.store.getExitIntent();
    // A quit that was writing its close when the process died: it was alive
    // and tracking right up to that moment.
    if (open && intent && intent.entryId === open.id) return intent.observedAt;
    return this.store.getLiveness();
  }

  /**
   * Close the open entry at `lastAlive` — the last proof before a gap nobody
   * reported. Same close as a suspend: any open entry, paused or not, ends
   * there; resuming afterwards starts a fresh one.
   */
  private closeForMissedSleep(lastAlive: AliveSample, gapMs: number): MissedSleep {
    const missed: MissedSleep = { gapMs, lastAliveWallMs: lastAlive.wallMs, closed: null };
    const open = this.open;
    if (!open) return missed;
    const closedAt = safeCloseAt(open, lastAlive.at);
    const closed = closeTimeEntry(open, closedAt);
    const nextState = this.writeEntry(closed);
    this.open = null;
    this.notifyMutation();
    this.syncInBackground([closed, nextState]);
    missed.closed = {
      entryId: open.id,
      closedAt,
      larkTaskGuid: open.larkTaskGuid ?? null,
      wasAccruing: getOpenSegment(open) !== null,
    };
    return missed;
  }

  /**
   * Turn "it happened N ms ago" into an instant in THIS module's frame.
   *
   * Callers must never hand in an instant. The timer keeps time on the
   * server-aligned clock while its callers read the device clock, and an instant
   * is meaningless without knowing which of the two produced it. On a machine a
   * few minutes out those two frames are not comparable, and `Math.max(at,
   * segment.startedAt)` — the guard meant to stop a boundary preceding its own
   * segment — silently collapses the segment to nothing instead, losing the
   * time it held.
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
    if (!exact && receipt.disposition === 'FINALIZED' && isClosedForSilence(receipt.canonicalEntry.closeReason)) {
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
    if (marked && receipt.correction === 'CLOCK_CLAMP') this.noteClockCorrection(entry, receipt);
    return marked;
  }

  /**
   * Tell the person the server moved this timer's end — only when it moved it
   * far enough to notice. CLOCK_CLAMP means a timestamp sat past the server's
   * now plus its skew allowance; a correction of seconds changes nothing the
   * person can see, so it stays silent. A crash or server notice still unread
   * matters more and is never overwritten.
   */
  private noteClockCorrection(entry: TimeEntry, receipt: TimerSyncReceipt): void {
    // Measured without zero-length segments: a server that drops one (and an
    // older server also called that a clamp) has not moved anything.
    const localBoundary = latestBoundary(dropZeroLengthSegments(entry).entry);
    const serverBoundary = latestBoundary(receipt.canonicalEntry);
    if (serverBoundary === null || localBoundary === null) return;
    if (localBoundary - serverBoundary <= CLOCK_CORRECTION_NOTICE_MS) return;
    if (this.store.getRecoveryNotice()) return;
    this.store.setRecoveryNotice({
      entryId: entry.id,
      recoveredAt: serverBoundary,
      reason: 'server_clock_corrected',
      observedAt: this.clock.now(),
    });
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
    const visible = owner && this.todayLedgerMode === 'VISIBLE' ? owner : null;
    const server = visible ? this.serverCache.list(visible, window.start, window.end, now) : [];
    return reconcileTodayLedger({
      local,
      server,
      invalidations: visible ? this.serverCache.invalidations?.(visible, window.start, window.end) ?? [] : [],
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

function sameOwner(a: TimerOwner | null, b: TimerOwner | null): boolean {
  if (!a || !b) return a === b;
  return a.userId === b.userId && a.workspaceId === b.workspaceId;
}

/**
 * The latest instant an entry claims, local (epoch ms) or from a receipt (ISO
 * strings) alike — where a clock clamp would have pulled it back to. Null when
 * a receipt timestamp does not parse.
 */
function latestBoundary(entry: {
  startedAt: number | string;
  endedAt: number | string | null;
  segments: Array<{ startedAt: number | string; endedAt: number | string | null }>;
}): number | null {
  const ms = (value: number | string) => (typeof value === 'number' ? value : Date.parse(value));
  let latest = ms(entry.startedAt);
  if (entry.endedAt !== null) latest = Math.max(latest, ms(entry.endedAt));
  for (const segment of entry.segments) {
    latest = Math.max(latest, ms(segment.startedAt));
    if (segment.endedAt !== null) latest = Math.max(latest, ms(segment.endedAt));
  }
  return Number.isFinite(latest) ? latest : null;
}

/** Never close before what the entry already holds: a boundary at `at` or later. */
function safeCloseAt(entry: TimeEntry, at: number): number {
  return Math.max(at, latestBoundary(entry) ?? entry.startedAt);
}

function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
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
