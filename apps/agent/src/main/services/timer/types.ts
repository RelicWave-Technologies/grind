import type { TimeEntry } from '@grind/core';

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
  /** Persist (insert or replace) an entry. */
  upsert(entry: TimeEntry): void;
  /** The currently-open entry (endedAt === null), if any. */
  getOpen(): TimeEntry | null;
  /** Entries that still need to be pushed to the server. */
  getUnsynced(): TimeEntry[];
  /** Most recent entries (newest first), for the day timeline / recent views. */
  listRecent(limit: number): TimeEntry[];
  /** Entries that overlap or continue after `since`, newest first. */
  listSince(since: number): TimeEntry[];
  /** Mark an entry as successfully synced. */
  markSynced(entryId: string): void;
  /**
   * Durable "last proof of life" timestamp, written periodically while a timer
   * actively accrues. On boot it bounds crash recovery: an ungraceful
   * shutdown (battery death, force-quit, kernel panic) leaves an entry open
   * with no `suspend`/`resume` to trim it, so we close it at the last liveness
   * tick instead of over-crediting the dead gap.
   */
  setLiveness(ts: number): void;
  getLiveness(): number | null;
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
