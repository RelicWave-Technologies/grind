import type { TimeEntry } from '@grind/core';

export type EntrySyncState = 'pending_create' | 'pending_update' | 'synced';
export type PendingEntrySyncState = Exclude<EntrySyncState, 'synced'>;
export type TimerExitReason = 'quit' | 'update' | 'shutdown';
export type TimerAwayReason = 'suspend' | 'lock';
export type TimerRecoveryReason = 'unexpected_shutdown' | 'sleep_stop' | 'lock_stop';

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
}

/** Injected dependencies so TimerService is testable without Electron/SQLite. */
export interface Clock {
  now(): number;
}

export interface IdGen {
  ulid(): string;
}

/**
 * Durable local persistence. The agent holds at most one open entry plus a
 * queue of entries pending sync to the API.
 */
export interface EntryStore {
  /**
   * Persist (insert or replace) an entry and return the local sync state.
   * Without an explicit state, dirtying a server-created entry becomes
   * pending_update while a not-yet-created entry stays pending_create.
   */
  upsert(entry: TimeEntry, opts?: { syncState?: PendingEntrySyncState }): PendingEntrySyncState;
  /** The currently-open entry (endedAt === null), if any. */
  getOpen(): TimeEntry | null;
  /** Entries that still need to be pushed to the server. */
  getUnsynced(): UnsyncedEntry[];
  /** Most recent entries (newest first), for the day timeline / recent views. */
  listRecent(limit: number): TimeEntry[];
  /** Entries that overlap or continue after `since`, newest first. */
  listSince(since: number): TimeEntry[];
  /** Mark an entry as created remotely, with its latest local snapshot still dirty. */
  markCreated(entryId: string): void;
  /** Mark an entry as requiring a create retry. */
  markPendingCreate(entryId: string): void;
  /**
   * Mark an entry as successfully synced. When `expectedEntry` is provided, the
   * store must only mark clean if the local JSON still matches that snapshot.
   */
  markSynced(entryId: string, expectedEntry?: TimeEntry): boolean;
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
  setRecoveryNotice(notice: TimerRecoveryNotice): void;
  getRecoveryNotice(): TimerRecoveryNotice | null;
  clearRecoveryNotice(): void;
}

/** Pushes entries to the backend. Implemented over the HTTP api client. */
export interface SyncClient {
  /** Create the entry server-side (idempotent on clientUuid). */
  create(entry: TimeEntry): Promise<void>;
  /** Replace the entry's segments / close it server-side (idempotent). */
  sync(entry: TimeEntry): Promise<void>;
}

export interface StartArgs {
  larkTaskGuid?: string | null;
}
