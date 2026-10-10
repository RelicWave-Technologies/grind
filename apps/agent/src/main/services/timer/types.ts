import type { ServerLedgerEntry, TimeEntry } from '@grind/core';
import type { TimerSyncReceipt } from '@grind/types';

export type EntrySyncState = 'pending_create' | 'pending_update' | 'synced';
export type PendingEntrySyncState = Exclude<EntrySyncState, 'synced'>;
export type TimerExitReason = 'quit' | 'update' | 'shutdown';
export type TimerAwayReason = 'suspend' | 'lock';
export type TimerRecoveryReason =
  | 'unexpected_shutdown'
  | 'sleep_stop'
  | 'lock_stop'
  | 'server_finalized'
  | 'server_clock_corrected';

export interface TimerExitIntent {
  reason: TimerExitReason;
  entryId: string;
  observedAt: number;
}

export interface TimerRecoveryNotice {
  entryId: string;
  recoveredAt: number;
  reason: TimerRecoveryReason;
  observedAt: number;
}

export interface TimerAwayState {
  reason: TimerAwayReason;
  entryId: string;
  awayStartedAt: number;
  observedAt: number;
}

export interface TimerRecoveryResult {
  entryId: string;
  recoveredAt: number;
  notice: TimerRecoveryNotice;
}

export interface UnsyncedEntry {
  entry: TimeEntry;
  syncState: PendingEntrySyncState;
  /** Consecutive failed pushes since the row last changed or synced. */
  attempts: number;
}

/** Closed entries in a time range still waiting on the server. */
export interface RangeBacklog {
  pending: number;
  /** Distinct recent push errors among them, newest first. */
  lastErrors: string[];
}

/** What is still waiting on this machine, for the heartbeat's diagnostics. */
export interface SyncBacklog {
  pending: number;
  oldestPendingAt: number | null;
  lastError: string | null;
}

export interface TimerOwner {
  userId: string;
  workspaceId: string;
}

export interface LocalLedgerEntry {
  entry: TimeEntry;
  syncState: EntrySyncState;
  acknowledgedRevision: number | null;
  acknowledgedHash: string | null;
}

export interface ServerLedgerCache {
  list(owner: TimerOwner, windowStart: number, windowEnd: number, now: number): ServerLedgerEntry[];
  /** Reviewer-invalidated windows from the same snapshot (never counted). */
  invalidations?(owner: TimerOwner, windowStart: number, windowEnd: number): Array<{ start: number; end: number }>;
}

/** Injected dependencies so TimerService is testable without Electron/SQLite. */
export interface Clock {
  /** The timer's frame: server-aligned, driven by a monotonic source. */
  now(): number;
  /**
   * Device wall clock. It keeps running while the machine sleeps, which is
   * how a sleep the OS never announced is still noticed. Defaults to now().
   */
  wallNow?(): number;
  /**
   * Raw monotonic reading, independent of server-clock re-anchoring. Advances
   * while a frozen process is not scheduled (Windows Modern Standby, a hung
   * event loop); on macOS it stops during real sleep. Defaults to now().
   */
  monoNow?(): number;
}

/** A sleep nobody reported, noticed from the gap between two proofs of life. */
export interface MissedSleep {
  /** How long the process went without a proof of life. */
  gapMs: number;
  /** Device wall clock at the last proof of life before the gap (for display). */
  lastAliveWallMs: number;
  /** The entry that was closed at that proof, or null when none was open. */
  closed: {
    entryId: string;
    /** Timer frame. */
    closedAt: number;
    larkTaskGuid: string | null;
    /** It was accruing (not paused), so the person can be offered a resume. */
    wasAccruing: boolean;
  } | null;
}

export interface IdGen {
  ulid(): string;
}

export interface TrackingAccrualGuard {
  assertCanAccrue(): Promise<void>;
}

export interface BusinessDayProvider {
  window(now: number): { start: number; end: number } | null;
}

/**
 * Durable local persistence. The agent holds at most one open entry plus a
 * queue of entries pending sync to the API.
 */
export interface EntryStore {
  bindOwner(owner: TimerOwner | null): void;
  currentOwner(): TimerOwner | null;
  /** Upgrade only rows already naming the authenticated user; ambiguous legacy rows stay quarantined. */
  claimUnownedEntries(owner: TimerOwner): number;
  /** Claim only legacy rows whose exact id/client UUID is proven by the owner-scoped API. */
  claimServerMatchedEntries(owner: TimerOwner, matches: Array<{ id: string; clientUuid: string }>): number;
  /**
   * Persist (insert or replace) an entry and return the local sync state.
   * Without an explicit state, dirtying a server-created entry becomes
   * pending_update while a not-yet-created entry stays pending_create.
   */
  upsert(entry: TimeEntry, opts?: { syncState?: PendingEntrySyncState }): PendingEntrySyncState;
  /** Atomically close the old task and create the replacement task. */
  switchEntry(closed: TimeEntry, next: TimeEntry): [PendingEntrySyncState, PendingEntrySyncState];
  /** The currently-open entry (endedAt === null), if any. */
  getOpen(): TimeEntry | null;
  /**
   * Entries due a push at `now`, oldest first — the open entry included, in
   * its place. Order matters: the server refuses a new live timer while an
   * older one of the same user is still open there, so an older close has to
   * land before a newer start, or the start 409s and waits out a backoff.
   *
   * Rows backing off after a failure are left out until their retry time, so
   * one entry the server keeps refusing can never starve the rest; and a pass
   * that hits its batch limit chains straight into the next (TimerSyncDrain),
   * so a long backlog delays the open entry by passes, not by intervals.
   */
  getUnsynced(now: number): UnsyncedEntry[];
  /** Count the failure and hold the row back until `retryAt`. */
  noteSyncFailure(entryId: string, error: string, retryAt: number): void;
  syncBacklog(): SyncBacklog;
  /** Closed entries overlapping [startMs, endMs) not yet acknowledged by the server. */
  rangeBacklog(startMs: number, endMs: number): RangeBacklog;
  hasUnsynced(): boolean;
  /** True until the entry has been created successfully on the server. */
  isPendingCreate(entryId: string): boolean;
  /** Entries that overlap or continue after `since`, newest first. */
  listSince(since: number): TimeEntry[];
  listLedgerEntries(since: number): LocalLedgerEntry[];
  /** Mark this exact snapshot as created remotely; stale responses cannot dirty newer JSON. */
  markCreated(entryId: string, expectedEntry: TimeEntry): boolean;
  /**
   * Push this entry again now, whatever its state or backoff — the server told
   * us its copy is missing or behind. Never demotes a pending create.
   */
  requeue(entryId: string, syncState: PendingEntrySyncState): boolean;
  /** Mark this exact snapshot as requiring a create retry. */
  markPendingCreate(entryId: string, expectedEntry: TimeEntry): boolean;
  /**
   * Mark an entry as successfully synced. When `expectedEntry` is provided, the
   * store must only mark clean if the local JSON still matches that snapshot.
   */
  markSynced(
    entryId: string,
    expectedEntry: TimeEntry,
    acknowledgement: { revision: number; hash: string },
  ): boolean;
  /**
   * Durable "last proof of life" timestamp, written periodically while a timer
   * actively accrues. On boot it bounds crash recovery: an ungraceful
   * shutdown (battery death, force-quit, kernel panic) leaves an entry open
   * with no `suspend`/`resume` to trim it, so we close it at the last liveness
   * tick instead of over-crediting the dead gap.
   */
  setLiveness(ts: number): void;
  getLiveness(): number | null;
  setExitIntent(intent: TimerExitIntent): void;
  getExitIntent(): TimerExitIntent | null;
  clearExitIntent(): void;
  setAwayState(state: TimerAwayState): void;
  getAwayState(): TimerAwayState | null;
  clearAwayState(): void;
  /** True the first time `key` is marked for the bound owner, false after. */
  markOnce(key: string): boolean;
  /** Small owner-scoped notes (remote command outcomes). Null when unset or signed out. */
  getNote(key: string): string | null;
  setNote(key: string, value: string): void;
  setRecoveryNotice(notice: TimerRecoveryNotice): void;
  getRecoveryNotice(): TimerRecoveryNotice | null;
  clearRecoveryNotice(): void;
}

/** Pushes entries to the backend. Implemented over the HTTP api client. */
export interface SyncClient {
  /** Create the entry server-side (idempotent on clientUuid). */
  create(entry: TimeEntry): Promise<TimerSyncReceipt>;
  /** Replace the entry's segments / close it server-side (idempotent). */
  sync(entry: TimeEntry): Promise<TimerSyncReceipt>;
}

export interface StartArgs {
  larkTaskGuid?: string | null;
}
