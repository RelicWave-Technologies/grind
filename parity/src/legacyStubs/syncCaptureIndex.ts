// `capture/index.ts` as the uploader imports it: a screenshot store that logs
// every mark in a line the Rust test reproduces. (The real `ScreenshotStore` is
// proven separately by the timo-store fixtures.)
import { sync } from './syncState';

const note = (...parts: unknown[]): void => {
  sync.storeCalls.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|'));
};

const store = {
  pending: (limit: number): unknown[] => sync.pendingRows.slice(0, limit),
  markUploading: (id: string): void => note('markUploading', id),
  markUploaded: (id: string, key: string): void => note('markUploaded', id, key),
  markPending: (id: string, lastError: string | null, nextAttemptAt: number | null): void =>
    note('markPending', id, lastError ?? 'null', nextAttemptAt),
  markRetryScheduled: (id: string, lastError: string, nextAttemptAt: number): void =>
    note('markRetryScheduled', id, lastError, nextAttemptAt),
  markTerminalFailed: (id: string, lastError: string): void => note('markTerminalFailed', id, lastError),
};

export const getScreenshotStore = (): typeof store => store;
