import { describe, it, expect } from 'vitest';
import { buildDayInsight, localDayWindow, type DayEntryInput, type PendingRequestInput } from './day';

/**
 * Pure tests for the day-insight composer. No DB. Carefully covers the
 * edge cases enumerated in §6 of the Edit Time plan: midnight crossing,
 * DST, open running segments, future days, empty days, multi-entry gap
 * detection, MANUAL overlay, PENDING clipping, idle-inside-entry.
 */

const TZ_NY = 'America/New_York';
const TZ_KOL = 'Asia/Calcutta';
const TZ_LA = 'America/Los_Angeles';

const date = (s: string) => new Date(s);

function makeWindow(d: string, tz: string) {
  const w = localDayWindow(d, tz);
  if (!w) throw new Error(`bad window for ${d} ${tz}`);
  return w;
}

describe('localDayWindow', () => {
  it('returns null for invalid YYYY-MM-DD', () => {
    expect(localDayWindow('2026/05/30', TZ_KOL)).toBeNull();
    expect(localDayWindow('not-a-date', TZ_KOL)).toBeNull();
  });

  it('returns null for invalid IANA timezone', () => {
    expect(localDayWindow('2026-05-30', 'Not/A_Zone')).toBeNull();
  });

  it('produces a 24h window on a non-DST day in Asia/Calcutta', () => {
    const w = makeWindow('2026-05-30', TZ_KOL);
    expect(w.end.getTime() - w.start.getTime()).toBe(24 * 3600 * 1000);
  });

  it('produces a 23h window on the DST spring-forward day in America/New_York (2026-03-08)', () => {
    const w = makeWindow('2026-03-08', TZ_NY);
    expect(w.end.getTime() - w.start.getTime()).toBe(23 * 3600 * 1000);
  });

  it('produces a 25h window on the DST fall-back day in America/Los_Angeles (2026-11-01)', () => {
    const w = makeWindow('2026-11-01', TZ_LA);
    expect(w.end.getTime() - w.start.getTime()).toBe(25 * 3600 * 1000);
  });
});

const baseEntry: DayEntryInput = {
  id: 'te_1',
  source: 'AUTO',
  larkTaskGuid: 'task_alpha',
  segments: [{ kind: 'WORK', startedAt: date('2026-05-30T09:00:00.000Z'), endedAt: date('2026-05-30T10:30:00.000Z') }],
};

describe('buildDayInsight — empty day', () => {
  it('returns no blocks and null activity bounds when nothing happened', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00.000Z'),
      entries: [],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    expect(r.blocks).toHaveLength(0);
    expect(r.firstActivityAt).toBeNull();
    expect(r.lastActivityAt).toBeNull();
    expect(r.totals).toEqual({ workedMs: 0, meetingMs: 0, manualMs: 0, idleTrimmedMs: 0, gapMs: 0 });
  });
});

describe('buildDayInsight — single tracked entry, fully inside', () => {
  it('emits one WORK block and no GAPs (envelope = exactly that block)', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00.000Z'),
      entries: [baseEntry],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.kind).toBe('WORK');
    expect(r.totals.workedMs).toBe(90 * 60 * 1000);
    expect(r.firstActivityAt).toBe(date('2026-05-30T09:00:00Z').getTime());
    expect(r.lastActivityAt).toBe(date('2026-05-30T10:30:00Z').getTime());
  });
});

describe('buildDayInsight — entry crosses midnight', () => {
  it('clips the WORK segment to the day window', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T12:00:00.000Z'),
      entries: [
        {
          id: 'te_x',
          source: 'AUTO',
          larkTaskGuid: null,
          segments: [{ kind: 'WORK', startedAt: date('2026-05-30T22:00:00Z'), endedAt: date('2026-05-31T01:30:00Z') }],
        },
      ],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    // Only 22:00 → 24:00 is in this day.
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.durationMs).toBe(2 * 3600 * 1000);
    expect(r.blocks[0]!.endedAt).toBe(date('2026-05-31T00:00:00Z').getTime());
  });
});

describe('buildDayInsight — open running segment today', () => {
  it('extends the open segment to `now` and marks isOpen', () => {
    const now = date('2026-05-30T09:45:00.000Z');
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now,
      entries: [
        {
          id: 'te_open',
          source: 'AUTO',
          larkTaskGuid: null,
          segments: [{ kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: null }],
        },
      ],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    expect(r.isToday).toBe(true);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.isOpen).toBe(true);
    expect(r.blocks[0]!.endedAt).toBe(now.getTime());
  });
});

describe('buildDayInsight — MEETING / IDLE_TRIMMED inside a tracked entry', () => {
  it('splits into MEETING and IDLE_TRIMMED blocks matching their segment kinds', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00.000Z'),
      entries: [
        {
          id: 'te_mixed',
          source: 'AUTO',
          larkTaskGuid: 'task_a',
          segments: [
            { kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: date('2026-05-30T10:00:00Z') },
            { kind: 'MEETING', startedAt: date('2026-05-30T10:00:00Z'), endedAt: date('2026-05-30T10:30:00Z') },
            { kind: 'IDLE_TRIMMED', startedAt: date('2026-05-30T10:30:00Z'), endedAt: date('2026-05-30T10:40:00Z') },
            { kind: 'WORK', startedAt: date('2026-05-30T10:40:00Z'), endedAt: date('2026-05-30T11:00:00Z') },
          ],
        },
      ],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    const kinds = r.blocks.map((b) => b.kind);
    expect(kinds).toEqual(['WORK', 'MEETING', 'IDLE_TRIMMED', 'WORK']);
    expect(r.totals.workedMs).toBe(80 * 60 * 1000);
    expect(r.totals.meetingMs).toBe(30 * 60 * 1000);
    expect(r.totals.idleTrimmedMs).toBe(10 * 60 * 1000);
    expect(r.totals.gapMs).toBe(0);
  });
});

describe('buildDayInsight — APPROVED MANUAL entry', () => {
  it('emits a MANUAL block (yellow) regardless of underlying segment kind', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00.000Z'),
      entries: [
        {
          id: 'te_manual',
          source: 'MANUAL',
          larkTaskGuid: 'task_b',
          segments: [
            { kind: 'WORK', startedAt: date('2026-05-30T14:00:00Z'), endedAt: date('2026-05-30T15:30:00Z') },
          ],
        },
      ],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.kind).toBe('MANUAL');
    expect(r.totals.manualMs).toBe(90 * 60 * 1000);
    expect(r.totals.workedMs).toBe(0);
  });
});

describe('buildDayInsight — multi-entry GAP detection (past day)', () => {
  it('inserts a GAP block between adjacent tracked entries; no leading/trailing gap', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00.000Z'),
      entries: [
        {
          id: 'a',
          source: 'AUTO',
          larkTaskGuid: 't1',
          segments: [{ kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: date('2026-05-30T11:00:00Z') }],
        },
        {
          id: 'b',
          source: 'AUTO',
          larkTaskGuid: 't1',
          segments: [{ kind: 'WORK', startedAt: date('2026-05-30T12:30:00Z'), endedAt: date('2026-05-30T14:00:00Z') }],
        },
      ],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    expect(r.blocks.map((b) => b.kind)).toEqual(['WORK', 'GAP', 'WORK']);
    expect(r.blocks[1]!.durationMs).toBe(90 * 60 * 1000);
    expect(r.totals.gapMs).toBe(90 * 60 * 1000);
  });
});

describe('buildDayInsight — today with trailing gap to now', () => {
  it('adds a final GAP from last tracked end to `now` (the visual present)', () => {
    const now = date('2026-05-30T15:00:00.000Z');
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now,
      entries: [
        {
          id: 'a',
          source: 'AUTO',
          larkTaskGuid: null,
          segments: [{ kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: date('2026-05-30T13:00:00Z') }],
        },
      ],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    expect(r.blocks.map((b) => b.kind)).toEqual(['WORK', 'GAP']);
    expect(r.blocks[1]!.endedAt).toBe(now.getTime());
    expect(r.lastActivityAt).toBe(now.getTime());
  });
});

describe('buildDayInsight — future date', () => {
  it('marks isFuture and emits no blocks', () => {
    const r = buildDayInsight({
      date: '2030-01-01',
      tz: 'UTC',
      now: date('2026-05-30T12:00:00Z'),
      entries: [],
      pending: [],
      window: makeWindow('2030-01-01', 'UTC'),
    });
    expect(r.isFuture).toBe(true);
    expect(r.blocks).toHaveLength(0);
  });
});

describe('buildDayInsight — PENDING request overlay', () => {
  it('clips PENDING requests to the day and surfaces them separately from blocks', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00.000Z'),
      entries: [],
      pending: [
        {
          id: 'req_1',
          requestedStart: date('2026-05-29T23:00:00Z'),
          requestedEnd: date('2026-05-30T02:00:00Z'),
          reason: 'late night work',
          larkTaskGuid: null,
        } satisfies PendingRequestInput,
        {
          id: 'req_2',
          requestedStart: date('2026-05-30T10:00:00Z'),
          requestedEnd: date('2026-05-30T11:00:00Z'),
          reason: 'lunch tracker',
          larkTaskGuid: 't1',
        } satisfies PendingRequestInput,
      ],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    expect(r.blocks).toHaveLength(0); // PENDING != real block
    expect(r.pendingOverlay).toHaveLength(2);
    // First one was clipped on the left edge.
    expect(r.pendingOverlay[0]!.startedAt).toBe(date('2026-05-30T00:00:00Z').getTime());
    expect(r.pendingOverlay[0]!.endedAt).toBe(date('2026-05-30T02:00:00Z').getTime());
    expect(r.pendingOverlay[1]!.larkTaskGuid).toBe('t1');
  });
});

describe('buildDayInsight — disjoint PENDING request', () => {
  it('drops PENDING requests that do not overlap the day at all', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00Z'),
      entries: [],
      pending: [
        {
          id: 'req_y',
          requestedStart: date('2026-05-28T09:00:00Z'),
          requestedEnd: date('2026-05-28T10:00:00Z'),
          reason: 'irrelevant',
          larkTaskGuid: null,
        },
      ],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    expect(r.pendingOverlay).toHaveLength(0);
  });
});

describe('buildDayInsight — totals accounting', () => {
  it('totals add up to (lastActivityAt − firstActivityAt) for past days with mixed kinds', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00Z'),
      entries: [
        {
          id: 'a',
          source: 'AUTO',
          larkTaskGuid: 't',
          segments: [
            { kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: date('2026-05-30T10:00:00Z') },
            { kind: 'MEETING', startedAt: date('2026-05-30T10:00:00Z'), endedAt: date('2026-05-30T10:30:00Z') },
          ],
        },
        {
          id: 'b',
          source: 'MANUAL',
          larkTaskGuid: 't',
          segments: [{ kind: 'WORK', startedAt: date('2026-05-30T11:30:00Z'), endedAt: date('2026-05-30T12:00:00Z') }],
        },
      ],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    const envelope = r.lastActivityAt! - r.firstActivityAt!;
    const sum = r.totals.workedMs + r.totals.meetingMs + r.totals.manualMs + r.totals.idleTrimmedMs + r.totals.gapMs;
    expect(sum).toBe(envelope);
  });
});
