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
  /** Mark an entry as successfully synced. */
  markSynced(entryId: string): void;
}

/** Pushes entries to the backend. Implemented over the HTTP api client. */
export interface SyncClient {
  /** Create the entry server-side (idempotent on clientUuid). */
  create(entry: TimeEntry): Promise<void>;
  /** Replace the entry's segments / close it server-side (idempotent). */
  sync(entry: TimeEntry): Promise<void>;
}

export interface StartArgs {
  projectId: string;
  taskId?: string | null;
  larkTaskGuid?: string | null;
}
