import { describe, it, expect } from 'vitest';
import {
  NINE_TO_SIX,
  LocalTimeResolutionError,
  instantForZonedDateTime,
  possibleInstantsForZonedDateTime,
} from '@grind/types';
import { buildDayInsight, localDayWindow, shiftDayWindow, type DayEntryInput, type PendingRequestInput } from './day';

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

describe('shared local wall-clock resolution', () => {
  it('rejects a nonexistent spring-forward time instead of silently changing it', () => {
    const resolve = () => instantForZonedDateTime({
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
      second: 0,
    }, TZ_NY);

    expect(resolve).toThrow(LocalTimeResolutionError);
    try {
      resolve();
    } catch (error) {
      expect((error as LocalTimeResolutionError).code).toBe('nonexistent_local_time');
    }
  });

  it('uses the earlier real instant for the repeated fall-back hour', () => {
    const parts = { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 };
    const candidates = possibleInstantsForZonedDateTime(parts, TZ_NY);

    expect(candidates.map((candidate) => candidate.toISOString())).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z',
    ]);
    expect(instantForZonedDateTime(parts, TZ_NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
});

const baseEntry: DayEntryInput = {
  id: 'te_1',
  source: 'AUTO',
  larkTaskGuid: 'task_alpha',
  segments: [{ kind: 'WORK', startedAt: date('2026-05-30T09:00:00.000Z'), endedAt: date('2026-05-30T10:30:00.000Z') }],
};

describe('buildDayInsight — empty day', () => {
  it('emits ONE full-day GAP block + null activity bounds + gapMs = 24h', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00.000Z'),
      entries: [],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.kind).toBe('GAP');
    expect(r.blocks[0]!.durationMs).toBe(24 * 3600 * 1000);
    expect(r.firstActivityAt).toBeNull();
    expect(r.lastActivityAt).toBeNull();
    expect(r.totals.gapMs).toBe(24 * 3600 * 1000);
  });
});

describe('buildDayInsight — single tracked entry, fully inside (past day)', () => {
  it('emits [leading-GAP, WORK, trailing-GAP] — the whole day is partitioned', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00.000Z'),
      entries: [baseEntry],
      pending: [],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'WORK', 'GAP']);
    expect(r.totals.workedMs).toBe(90 * 60 * 1000);
    expect(r.firstActivityAt).toBe(date('2026-05-30T09:00:00Z').getTime());
    expect(r.lastActivityAt).toBe(date('2026-05-30T10:30:00Z').getTime());
    // Gap durations: midnight to 9am (9h) + 10:30am to midnight (13.5h)
    expect(r.blocks[0]!.durationMs).toBe(9 * 3600 * 1000);
    expect(r.blocks[2]!.durationMs).toBe(13.5 * 3600 * 1000);
  });
});

describe('buildDayInsight — entry crosses midnight', () => {
  it('clips the WORK segment to the day window — leading gap + WORK ending at midnight', () => {
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
    // [leading GAP 12am-10pm, WORK 10pm-midnight]. No trailing gap (work ends at midnight).
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'WORK']);
    const workBlock = r.blocks[1]!;
    expect(workBlock.durationMs).toBe(2 * 3600 * 1000);
    expect(workBlock.endedAt).toBe(date('2026-05-31T00:00:00Z').getTime());
  });
});

describe('buildDayInsight — open running segment today', () => {
  it('emits [leading-GAP, open-WORK] — no trailing gap because work ends at now', () => {
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
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'WORK']);
    const workBlock = r.blocks[1]!;
    expect(workBlock.isOpen).toBe(true);
    expect(workBlock.endedAt).toBe(now.getTime());
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
    // Leading + trailing gaps wrap the segment-derived blocks.
    expect(kinds).toEqual(['GAP', 'WORK', 'MEETING', 'IDLE_TRIMMED', 'WORK', 'GAP']);
    expect(r.totals.workedMs).toBe(80 * 60 * 1000);
    expect(r.totals.meetingMs).toBe(30 * 60 * 1000);
    expect(r.totals.idleTrimmedMs).toBe(10 * 60 * 1000);
    // Full day - 2h tracked = 22h of gap.
    expect(r.totals.gapMs).toBe(22 * 3600 * 1000);
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
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'MANUAL', 'GAP']);
    const manualBlock = r.blocks[1]!;
    expect(manualBlock.kind).toBe('MANUAL');
    expect(r.totals.manualMs).toBe(90 * 60 * 1000);
    expect(r.totals.workedMs).toBe(0);
  });
});

describe('buildDayInsight — multi-entry GAP detection (past day)', () => {
  it('inserts leading + inter-block + trailing GAPs around tracked entries', () => {
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
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'WORK', 'GAP', 'WORK', 'GAP']);
    // Inter-block gap: 11am-12:30pm = 1.5h
    expect(r.blocks[2]!.durationMs).toBe(90 * 60 * 1000);
    // Total gaps: 9h (leading) + 1.5h (inter) + 10h (trailing) = 20.5h
    expect(r.totals.gapMs).toBe(20.5 * 3600 * 1000);
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
    // [leading GAP 12am-9am, WORK 9am-1pm, trailing GAP 1pm-now=3pm]
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'WORK', 'GAP']);
    expect(r.blocks[2]!.endedAt).toBe(now.getTime());
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

describe('buildDayInsight — PENDING carved into the partition (no duplicacy)', () => {
  it('clips PENDING requests to the day and emits them as PENDING blocks, never overlapping a gap', () => {
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
    // Single partition: PENDING(00-02) · GAP(02-10) · PENDING(10-11) · GAP(11-24).
    expect(r.blocks.map((b) => b.kind)).toEqual(['PENDING', 'GAP', 'PENDING', 'GAP']);
    const p1 = r.blocks[0]!;
    expect(p1.startedAt).toBe(date('2026-05-30T00:00:00Z').getTime()); // clipped left edge
    expect(p1.endedAt).toBe(date('2026-05-30T02:00:00Z').getTime());
    expect(p1.requestId).toBe('req_1');
    expect(r.blocks[2]!.larkTaskGuid).toBe('t1');
    expect(r.blocks[2]!.requestId).toBe('req_2');
    expect(r.totals.pendingMs).toBe(3 * 3600 * 1000);
    // Every minute is covered exactly once → partition sums to the full day.
    const sum = r.totals.workedMs + r.totals.meetingMs + r.totals.manualMs + r.totals.idleTrimmedMs + r.totals.pendingMs + r.totals.gapMs;
    expect(sum).toBe(24 * 3600 * 1000);
  });

  it('a PENDING that overlaps tracked time is carved to the empty part only (real time wins)', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00.000Z'),
      entries: [
        {
          id: 'te',
          source: 'AUTO',
          larkTaskGuid: null,
          segments: [{ kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: date('2026-05-30T10:00:00Z') }],
        },
      ],
      pending: [
        {
          id: 'req_over',
          requestedStart: date('2026-05-30T09:30:00Z'), // overlaps the WORK block
          requestedEnd: date('2026-05-30T11:00:00Z'),
          reason: 'overlaps tracked',
          larkTaskGuid: null,
        },
      ],
      window: makeWindow('2026-05-30', 'UTC'),
    });
    // GAP(0-9) · WORK(9-10) · PENDING(10-11, the part past the WORK) · GAP(11-24).
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'WORK', 'PENDING', 'GAP']);
    const pend = r.blocks.find((b) => b.kind === 'PENDING')!;
    expect(pend.startedAt).toBe(date('2026-05-30T10:00:00Z').getTime());
    expect(pend.endedAt).toBe(date('2026-05-30T11:00:00Z').getTime());
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
    // No pending in range → the day is one full GAP, no PENDING blocks.
    expect(r.blocks.every((b) => b.kind !== 'PENDING')).toBe(true);
    expect(r.totals.pendingMs).toBe(0);
  });
});

describe('shiftDayWindow', () => {
  it('returns the shift bounds for a working weekday (Mon 09:00–18:00)', () => {
    const w = shiftDayWindow('2026-06-01', 'UTC', NINE_TO_SIX); // 2026-06-01 is a Monday
    expect(w).not.toBeNull();
    expect(w!.start.toISOString()).toBe('2026-06-01T09:00:00.000Z');
    expect(w!.end.toISOString()).toBe('2026-06-01T18:00:00.000Z');
  });

  it('returns null on a day off (Saturday in NINE_TO_SIX) → caller falls back to full day', () => {
    expect(shiftDayWindow('2026-06-06', 'UTC', NINE_TO_SIX)).toBeNull(); // 2026-06-06 is a Saturday
  });

  it('resolves the shift start in the user local tz (09:00 EDT = 13:00 UTC)', () => {
    const w = shiftDayWindow('2026-06-01', 'America/New_York', NINE_TO_SIX);
    expect(w!.start.toISOString()).toBe('2026-06-01T13:00:00.000Z');
  });
});

describe('buildDayInsight — shift-bounded frame', () => {
  it('frames the day to the shift window when all activity is inside it', () => {
    const r = buildDayInsight({
      date: '2026-06-01',
      tz: 'UTC',
      now: date('2026-06-02T00:00:00Z'),
      entries: [
        {
          id: 'a',
          source: 'AUTO',
          larkTaskGuid: null,
          segments: [{ kind: 'WORK', startedAt: date('2026-06-01T10:00:00Z'), endedAt: date('2026-06-01T11:00:00Z') }],
        },
      ],
      pending: [],
      window: shiftDayWindow('2026-06-01', 'UTC', NINE_TO_SIX)!,
      calendarDay: makeWindow('2026-06-01', 'UTC'),
      shift: { name: 'Day', start: '09:00', end: '18:00' },
    });
    expect(r.dayStart).toBe(date('2026-06-01T09:00:00Z').getTime());
    expect(r.dayEnd).toBe(date('2026-06-01T18:00:00Z').getTime());
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'WORK', 'GAP']);
    expect(r.shift?.name).toBe('Day');
    // Partition sums to the 9h shift span (not 24h).
    expect(r.totals.workedMs + r.totals.gapMs).toBe(9 * 3600 * 1000);
  });

  it('EXPANDS the frame to include work outside the shift — off-shift time is never hidden', () => {
    const r = buildDayInsight({
      date: '2026-06-01',
      tz: 'UTC',
      now: date('2026-06-02T00:00:00Z'),
      entries: [
        {
          id: 'a',
          source: 'AUTO',
          larkTaskGuid: null,
          // 07:00–08:00, an hour BEFORE the 09:00 shift start.
          segments: [{ kind: 'WORK', startedAt: date('2026-06-01T07:00:00Z'), endedAt: date('2026-06-01T08:00:00Z') }],
        },
      ],
      pending: [],
      window: shiftDayWindow('2026-06-01', 'UTC', NINE_TO_SIX)!,
      calendarDay: makeWindow('2026-06-01', 'UTC'),
      shift: { name: 'Day', start: '09:00', end: '18:00' },
    });
    // Frame expands left to 07:00 so the off-shift hour shows; right stays at the shift end.
    expect(r.dayStart).toBe(date('2026-06-01T07:00:00Z').getTime());
    expect(r.dayEnd).toBe(date('2026-06-01T18:00:00Z').getTime());
    expect(r.blocks[0]!.kind).toBe('WORK');
    expect(r.blocks[0]!.startedAt).toBe(date('2026-06-01T07:00:00Z').getTime());
  });
});

describe('buildDayInsight — coalescing (clean, continuous blocks)', () => {
  const dayWin = () => ({ window: makeWindow('2026-05-30', 'UTC'), calendarDay: makeWindow('2026-05-30', 'UTC') });

  it('folds a sub-2-min idle sliver INTO the surrounding work (one continuous block)', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00Z'),
      entries: [
        {
          id: 'e',
          source: 'AUTO',
          larkTaskGuid: 't',
          segments: [
            { kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: date('2026-05-30T09:30:00Z') },
            { kind: 'IDLE_TRIMMED', startedAt: date('2026-05-30T09:30:00Z'), endedAt: date('2026-05-30T09:31:00Z') }, // 1 min
            { kind: 'WORK', startedAt: date('2026-05-30T09:31:00Z'), endedAt: date('2026-05-30T10:00:00Z') },
          ],
        },
      ],
      pending: [],
      ...dayWin(),
    });
    // The 1-min idle vanishes from the display; the two WORK runs merge into one.
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'WORK', 'GAP']);
    const work = r.blocks.find((b) => b.kind === 'WORK')!;
    expect(work.startedAt).toBe(date('2026-05-30T09:00:00Z').getTime());
    expect(work.endedAt).toBe(date('2026-05-30T10:00:00Z').getTime());
    // Totals stay EXACT — the trimmed idle is still counted, just not shown.
    expect(r.totals.idleTrimmedMs).toBe(60_000);
    expect(r.totals.workedMs).toBe(59 * 60_000);
  });

  it('does NOT fold a long (≥2-min) idle — a real break stays its own row', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00Z'),
      entries: [
        {
          id: 'e',
          source: 'AUTO',
          larkTaskGuid: 't',
          segments: [
            { kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: date('2026-05-30T09:30:00Z') },
            { kind: 'IDLE_TRIMMED', startedAt: date('2026-05-30T09:30:00Z'), endedAt: date('2026-05-30T09:40:00Z') }, // 10 min
            { kind: 'WORK', startedAt: date('2026-05-30T09:40:00Z'), endedAt: date('2026-05-30T10:00:00Z') },
          ],
        },
      ],
      pending: [],
      ...dayWin(),
    });
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'WORK', 'IDLE_TRIMMED', 'WORK', 'GAP']);
  });

  it('folds sub-2-min WORK↔MEETING kind-flaps (same task) into ONE dominant block', () => {
    // The real bug: old meeting-detection flapping made a task look like 5 rows
    // (24s WORK, 30s MEETING, 10s WORK, 30s MEETING, ~4.7m WORK) — all one task.
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00Z'),
      entries: [
        {
          id: 'e',
          source: 'AUTO',
          larkTaskGuid: 't',
          segments: [
            { kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: date('2026-05-30T09:00:24Z') },
            { kind: 'MEETING', startedAt: date('2026-05-30T09:00:24Z'), endedAt: date('2026-05-30T09:00:54Z') },
            { kind: 'WORK', startedAt: date('2026-05-30T09:00:54Z'), endedAt: date('2026-05-30T09:01:04Z') },
            { kind: 'MEETING', startedAt: date('2026-05-30T09:01:04Z'), endedAt: date('2026-05-30T09:01:34Z') },
            { kind: 'WORK', startedAt: date('2026-05-30T09:01:34Z'), endedAt: date('2026-05-30T09:06:15Z') },
          ],
        },
      ],
      pending: [],
      ...dayWin(),
    });
    const tracked = r.blocks.filter((b) => b.kind !== 'GAP');
    expect(tracked).toHaveLength(1); // five flap rows → one block
    expect(tracked[0]!.kind).toBe('WORK'); // dominant by duration
    expect(tracked[0]!.startedAt).toBe(date('2026-05-30T09:00:00Z').getTime());
    expect(tracked[0]!.endedAt).toBe(date('2026-05-30T09:06:15Z').getTime());
    // Totals still count the meeting time EXACTLY (just not shown as a row).
    expect(r.totals.meetingMs).toBe(60_000);
  });

  it('preserves a REAL (≥2-min) meeting inside a task as its own block', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00Z'),
      entries: [
        {
          id: 'e',
          source: 'AUTO',
          larkTaskGuid: 't',
          segments: [
            { kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: date('2026-05-30T09:10:00Z') },
            { kind: 'MEETING', startedAt: date('2026-05-30T09:10:00Z'), endedAt: date('2026-05-30T09:40:00Z') }, // 30m real
            { kind: 'WORK', startedAt: date('2026-05-30T09:40:00Z'), endedAt: date('2026-05-30T10:00:00Z') },
          ],
        },
      ],
      pending: [],
      ...dayWin(),
    });
    expect(r.blocks.map((b) => b.kind)).toEqual(['GAP', 'WORK', 'MEETING', 'WORK', 'GAP']);
  });

  it('keeps different tasks as separate blocks even when contiguous', () => {
    const r = buildDayInsight({
      date: '2026-05-30',
      tz: 'UTC',
      now: date('2026-05-31T00:00:00Z'),
      entries: [
        { id: 'a', source: 'AUTO', larkTaskGuid: 'task-A', segments: [{ kind: 'WORK', startedAt: date('2026-05-30T09:00:00Z'), endedAt: date('2026-05-30T09:30:00Z') }] },
        { id: 'b', source: 'AUTO', larkTaskGuid: 'task-B', segments: [{ kind: 'WORK', startedAt: date('2026-05-30T09:30:00Z'), endedAt: date('2026-05-30T10:00:00Z') }] },
      ],
      pending: [],
      ...dayWin(),
    });
    const works = r.blocks.filter((b) => b.kind === 'WORK');
    expect(works).toHaveLength(2); // task change breaks the merge
    expect(works[0]!.larkTaskGuid).toBe('task-A');
    expect(works[1]!.larkTaskGuid).toBe('task-B');
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
    // With full-day partitioning, totals sum to the day's billable span:
    // 24h for past days, min(now-dayStart, 24h) for today / cropped for
    // future. This test uses a past day so the sum is exactly 24h.
    const fullDay = 24 * 3600 * 1000;
    const sum =
      r.totals.workedMs + r.totals.meetingMs + r.totals.manualMs + r.totals.idleTrimmedMs + r.totals.pendingMs + r.totals.gapMs;
    expect(sum).toBe(fullDay);
  });
});
