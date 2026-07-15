import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { TimeEntry } from './types';
import { reconcileTodayLedger } from './todayLedger';
import { canonicalTimerEntryPayload } from './timerLedger';

function entry(id: string, revision: number, start: number, end: number | null): TimeEntry {
  return {
    id,
    clientUuid: `client-${id}`,
    userId: 'user-1',
    larkTaskGuid: null,
    source: 'AUTO',
    revision,
    startedAt: start,
    endedAt: end,
    pauseReason: null,
    closeReason: end === null ? null : 'AGENT',
    segments: [{ id: `segment-${id}`, kind: 'WORK', startedAt: start, endedAt: end }],
  };
}

function server(entryValue: TimeEntry, effective = entryValue) {
  const canonicalPayload = canonicalTimerEntryPayload(entryValue);
  return {
    entry: effective,
    canonicalPayload,
    canonicalHash: createHash('sha256').update(canonicalPayload).digest('hex'),
  };
}

describe('reconcileTodayLedger', () => {
  it('adds pending local time without duplicating server-confirmed time', () => {
    const confirmed = entry('confirmed', 2, 0, 4.5 * 60 * 60_000);
    const pending = entry('pending', 1, 4.5 * 60 * 60_000, 5 * 60 * 60_000);
    const projection = reconcileTodayLedger({
      local: [
        { entry: confirmed, syncState: 'synced' },
        { entry: pending, syncState: 'pending_create' },
      ],
      server: [server(confirmed)],
      windowStart: 0,
      windowEnd: 24 * 60 * 60_000,
      now: 5 * 60 * 60_000,
    });
    expect(projection.workedMs).toBe(5 * 60 * 60_000);
    expect(projection.entries.find((item) => item.entry.id === 'pending')?.pending).toBe(true);
  });

  it('keeps the visible total stable after the pending row is acknowledged', () => {
    const first = entry('confirmed', 2, 0, 4.5 * 60 * 60_000);
    const second = entry('pending', 1, 4.5 * 60 * 60_000, 5 * 60 * 60_000);
    const projection = reconcileTodayLedger({
      local: [
        { entry: first, syncState: 'synced' },
        { entry: second, syncState: 'synced' },
      ],
      server: [server(first), server(second)],
      windowStart: 0,
      windowEnd: 24 * 60 * 60_000,
      now: 5 * 60 * 60_000,
    });
    expect(projection.workedMs).toBe(5 * 60 * 60_000);
  });

  it('uses interval union when separate rows overlap', () => {
    const a = entry('a', 1, 0, 60_000);
    const b = entry('b', 1, 30_000, 90_000);
    const projection = reconcileTodayLedger({
      local: [{ entry: a, syncState: 'pending_create' }],
      server: [server(b)],
      windowStart: 0,
      windowEnd: 100_000,
      now: 100_000,
    });
    expect(projection.workedMs).toBe(90_000);
    expect(projection.conflicts).toBe(2);
  });

  it('is deterministic and does not mutate either source', () => {
    const localEntry = entry('same', 2, 0, 60_000);
    const serverEntry = entry('same', 1, 0, 30_000);
    const local = [{ entry: localEntry, syncState: 'pending_update' as const }];
    const serverEntries = [server(serverEntry)];
    const before = JSON.stringify({ local, serverEntries });
    const input = { local, server: serverEntries, windowStart: 0, windowEnd: 100_000, now: 100_000 };
    expect(reconcileTodayLedger(input)).toEqual(reconcileTodayLedger(input));
    expect(JSON.stringify({ local, serverEntries })).toBe(before);
  });

  it('uses an effective capped view without changing canonical comparison', () => {
    const canonical = entry('open', 1, 0, null);
    const effective = entry('open', 1, 0, 60_000);
    const projection = reconcileTodayLedger({
      local: [{ entry: canonical, syncState: 'synced' }],
      server: [server(canonical, effective)],
      windowStart: 0,
      windowEnd: 100_000,
      now: 100_000,
    });
    expect(projection.workedMs).toBe(60_000);
    expect(projection.entries[0]?.conflicts).toEqual([]);
  });

  it('never lets an expired server cache freeze the currently active local timer', () => {
    const active = entry('active', 1, 0, null);
    const capped = entry('active', 1, 0, 60_000);
    const projection = reconcileTodayLedger({
      local: [{ entry: active, syncState: 'synced' }],
      server: [server(active, capped)],
      activeLocalEntryId: active.id,
      windowStart: 0,
      windowEnd: 200_000,
      now: 120_000,
    });
    expect(projection.workedMs).toBe(120_000);
    expect(projection.entries[0]).toMatchObject({ origin: 'LOCAL', pending: false });
  });

  it('applies only a server correction that was explicitly acknowledged', () => {
    const localEntry = entry('corrected', 2, 0, 80_000);
    const corrected = entry('corrected', 2, 0, 60_000);
    const serverEntry = server(corrected);
    const projection = reconcileTodayLedger({
      local: [{
        entry: localEntry,
        syncState: 'synced',
        acknowledgedRevision: 2,
        acknowledgedHash: serverEntry.canonicalHash,
      }],
      server: [serverEntry],
      windowStart: 0,
      windowEnd: 100_000,
      now: 100_000,
    });
    expect(projection.workedMs).toBe(60_000);
    expect(projection.entries[0]?.conflicts).toContain('ACKNOWLEDGED_SERVER_CORRECTION');
  });
});
