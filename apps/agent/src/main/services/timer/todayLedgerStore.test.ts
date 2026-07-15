import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { TodayLedgerResponse } from '@grind/types';
import { SqliteTodayLedgerStore } from './todayLedgerStore';

const owner = { userId: 'user-1', workspaceId: 'workspace-1' };
const window = { start: 0, end: 86_400_000 };

function snapshot(overrides: Partial<TodayLedgerResponse> = {}): TodayLedgerResponse {
  return {
    complete: true,
    serverTime: new Date(10_000).toISOString(),
    workspaceTimezone: 'Asia/Kolkata',
    entries: [{
      id: 'server-entry',
      clientUuid: 'server-client',
      userId: owner.userId,
      larkTaskGuid: null,
      source: 'AUTO',
      trackingProtocolVersion: 2,
      revision: 2,
      lastProvenAt: new Date(5_000).toISOString(),
      leaseExpiresAt: new Date(8_000).toISOString(),
      closeReason: null,
      serverFinalizedAt: null,
      startedAt: new Date(1_000).toISOString(),
      endedAt: null,
      notes: null,
      segments: [{
        id: 'server-segment',
        kind: 'WORK',
        startedAt: new Date(1_000).toISOString(),
        endedAt: null,
      }],
    }],
    effectiveEntries: [{
      entryId: 'server-entry',
      endedAt: new Date(5_000).toISOString(),
      segments: [{ segmentId: 'server-segment', endedAt: new Date(5_000).toISOString() }],
    }],
    ...overrides,
  };
}

describe('SqliteTodayLedgerStore', () => {
  it('caps an expired open lease at the last proven boundary', () => {
    const db = new Database(':memory:');
    const store = new SqliteTodayLedgerStore(db);
    store.replaceSnapshot(owner, window, snapshot());
    const [entry] = store.list(owner, window.start, window.end, 20_000);
    expect(entry?.entry.endedAt).toBe(5_000);
    expect(entry?.entry.segments[0]?.endedAt).toBe(5_000);
  });

  it('keeps the previous complete snapshot when a replacement fails validation', () => {
    const db = new Database(':memory:');
    const store = new SqliteTodayLedgerStore(db);
    store.replaceSnapshot(owner, window, snapshot());
    const invalid = snapshot({
      entries: [{ ...snapshot().entries[0]!, userId: 'another-user' }],
    });
    expect(() => store.replaceSnapshot(owner, window, invalid)).toThrow('today_ledger_owner_mismatch');
    expect(store.list(owner, window.start, window.end, 20_000)).toHaveLength(1);
  });

  it('does not expose cached rows across owners', () => {
    const db = new Database(':memory:');
    const store = new SqliteTodayLedgerStore(db);
    store.replaceSnapshot(owner, window, snapshot());
    expect(store.list({ userId: 'user-2', workspaceId: owner.workspaceId }, window.start, window.end, 20_000)).toEqual([]);
  });

  it('falls back to local-only when the advisory cache is corrupt', () => {
    const db = new Database(':memory:');
    const store = new SqliteTodayLedgerStore(db);
    store.replaceSnapshot(owner, window, snapshot());
    db.prepare(`UPDATE server_entry_cache SET canonical_json = 'not-json'`).run();

    expect(store.list(owner, window.start, window.end, 20_000)).toEqual([]);
  });
});
