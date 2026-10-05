import { describe, expect, it } from 'vitest';
import { localDayWindowInTimeZone } from '@grind/types';
import {
  containsInstant,
  intersectIntervals,
  mergeIntervals,
  splitByIntervals,
  subtractIntervals,
} from './intervals';
import { countedMs, resolveTimeline, totalsByTask, type TimelineEntry } from './timeline';
import { bucketByDay } from './days';
import { assignmentForDate, shiftWindowFor } from './shift';
import {
  DEFAULT_LATE_GRACE_MINUTES,
  FULL_DAY_MINUTES,
  HALF_DAY_MINUTES,
  dayCredit,
  isLate,
  lateExempt,
  shiftStatusFor,
} from './classify';

const MIN = 60_000;
const H = 60 * MIN;
const at = (iso: string) => new Date(iso);
const ms = (iso: string) => new Date(iso).getTime();

function entry(
  id: string,
  segments: Array<[kind: string, start: string, end: string | null]>,
  extra: Partial<TimelineEntry> = {},
): TimelineEntry {
  return {
    id,
    userId: 'u1',
    source: 'AUTO',
    larkTaskGuid: null,
    endedAt: segments.every((s) => s[2] !== null) ? at(segments[segments.length - 1]![2]!) : null,
    segments: segments.map(([kind, start, end]) => ({ kind, startedAt: at(start), endedAt: end ? at(end) : null })),
    ...extra,
  };
}

describe('interval primitives', () => {
  it('subtracts unsorted, overlapping holes', () => {
    expect(subtractIntervals([{ start: 0, end: 100 }], [{ start: 50, end: 60 }, { start: 10, end: 20 }, { start: 15, end: 30 }]))
      .toEqual([{ start: 0, end: 10 }, { start: 30, end: 50 }, { start: 60, end: 100 }]);
  });

  it('intersects two interval sets', () => {
    expect(intersectIntervals([{ start: 0, end: 10 }, { start: 20, end: 30 }], [{ start: 5, end: 25 }]))
      .toEqual([{ start: 5, end: 10 }, { start: 20, end: 25 }]);
  });

  it('treats the end of a half-open interval as outside', () => {
    const merged = mergeIntervals([{ start: 10, end: 20 }, { start: 30, end: 40 }]);
    expect(containsInstant(merged, 10)).toBe(true);
    expect(containsInstant(merged, 20)).toBe(false);
    expect(containsInstant(merged, 35)).toBe(true);
  });

  it('splits items at cut boundaries and marks the inside parts', () => {
    const parts = splitByIntervals([{ start: 0, end: 100, id: 'a' }], [{ start: 20, end: 30 }, { start: 90, end: 200 }]);
    expect(parts.map((p) => [p.start, p.end, p.inside])).toEqual([
      [0, 20, false], [20, 30, true], [30, 90, false], [90, 100, true],
    ]);
  });
});

describe('resolveTimeline', () => {
  const now = at('2026-07-11T18:00:00Z');

  it('gives every instant one owner: tracked beats manual beats idle', () => {
    const pieces = resolveTimeline([
      entry('work', [['WORK', '2026-07-11T09:00:00Z', '2026-07-11T10:00:00Z'], ['IDLE_TRIMMED', '2026-07-11T10:00:00Z', '2026-07-11T11:00:00Z']]),
      entry('manual', [['WORK', '2026-07-11T09:30:00Z', '2026-07-11T10:30:00Z']], { source: 'MANUAL' }),
    ], { now, trustOpenSegments: true });
    expect(pieces.map((p) => [p.entry.id, p.kind, new Date(p.start).toISOString().slice(11, 16), new Date(p.end).toISOString().slice(11, 16)]))
      .toEqual([
        ['work', 'WORK', '09:00', '10:00'],
        ['manual', 'MANUAL', '10:00', '10:30'],
        ['work', 'IDLE', '10:30', '11:00'],
      ]);
    expect(countedMs(pieces)).toBe(90 * MIN);
  });

  it('keeps invalidated pieces visible but never counted', () => {
    const pieces = resolveTimeline(
      [entry('work', [['WORK', '2026-07-11T09:00:00Z', '2026-07-11T11:00:00Z']])],
      { now, trustOpenSegments: true, invalidations: [{ userId: 'u1', start: ms('2026-07-11T09:30:00Z'), end: ms('2026-07-11T10:00:00Z') }] },
    );
    expect(pieces.map((p) => p.invalidated)).toEqual([false, true, false]);
    expect(countedMs(pieces)).toBe(90 * MIN);
  });

  it('caps an abandoned legacy open segment at its last proof', () => {
    const pieces = resolveTimeline(
      [entry('legacy', [['WORK', '2026-07-11T09:00:00Z', null]])],
      {
        now,
        evidence: new Map([['legacy', { latestStoredProofAt: at('2026-07-11T09:40:00Z'), latestHeartbeatAt: null }]]),
      },
    );
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.end).toBe(ms('2026-07-11T09:40:00Z'));
    expect(pieces[0]!.live).toBe(false);
  });

  it('runs a live segment to now and never past it', () => {
    const pieces = resolveTimeline(
      [entry('live', [['WORK', '2026-07-11T17:00:00Z', null]])],
      { now, evidence: new Map([['live', { latestStoredProofAt: null, latestHeartbeatAt: at('2026-07-11T17:59:00Z') }]]) },
    );
    expect(pieces[0]!.end).toBe(now.getTime());
    expect(pieces[0]!.live).toBe(true);
  });

  it('splits task totals so they never add up to more than the day', () => {
    const pieces = resolveTimeline([
      entry('a', [['WORK', '2026-07-11T09:00:00Z', '2026-07-11T10:00:00Z']], { larkTaskGuid: 'task-a' }),
      entry('b', [['WORK', '2026-07-11T09:30:00Z', '2026-07-11T10:30:00Z']], { larkTaskGuid: 'task-b' }),
      entry('m', [['WORK', '2026-07-11T10:00:00Z', '2026-07-11T11:00:00Z']], { source: 'MANUAL', larkTaskGuid: 'task-a' }),
    ], { now, trustOpenSegments: true, invalidations: [{ userId: 'u1', start: ms('2026-07-11T10:45:00Z'), end: ms('2026-07-11T11:00:00Z') }] });
    const byTask = totalsByTask(pieces);
    const sum = [...byTask.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBe(countedMs(pieces));
    expect(byTask.get('task-a')).toBe(60 * MIN + 15 * MIN);
    expect(byTask.get('task-b')).toBe(30 * MIN);
  });
});

describe('bucketByDay', () => {
  it('splits work across midnight and does not treat the spill-over as an early start', () => {
    const tz = 'Asia/Kolkata';
    const pieces = resolveTimeline([
      // 22:30 → 01:30 IST, then a real start at 09:40 IST.
      entry('night', [['WORK', '2026-07-10T17:00:00Z', '2026-07-10T20:00:00Z']]),
      entry('day', [['WORK', '2026-07-11T04:10:00Z', '2026-07-11T05:10:00Z']]),
    ], { now: at('2026-07-12T00:00:00Z'), trustOpenSegments: true });
    const buckets = bucketByDay(pieces, tz, ['2026-07-10', '2026-07-11']);
    const d10 = buckets.get('u1')!.get('2026-07-10')!;
    const d11 = buckets.get('u1')!.get('2026-07-11')!;
    expect(d10.counted).toBe(1.5 * H);
    expect(d11.counted).toBe(2.5 * H);
    expect(d11.firstTracked).toBe(ms('2026-07-11T04:10:00Z'));
    expect(d11.first).toBe(ms('2026-07-11T04:10:00Z'));
    expect(d10.firstTracked).toBe(ms('2026-07-10T17:00:00Z'));
  });

  it('first tracked ignores manual time and invalidated time', () => {
    const pieces = resolveTimeline([
      entry('manual', [['WORK', '2026-07-11T03:00:00Z', '2026-07-11T04:00:00Z']], { source: 'MANUAL' }),
      entry('work', [['WORK', '2026-07-11T04:00:00Z', '2026-07-11T06:00:00Z']]),
    ], {
      now: at('2026-07-12T00:00:00Z'),
      trustOpenSegments: true,
      invalidations: [{ userId: 'u1', start: ms('2026-07-11T04:00:00Z'), end: ms('2026-07-11T04:30:00Z') }],
    });
    const d = bucketByDay(pieces, 'UTC', ['2026-07-11']).get('u1')!.get('2026-07-11')!;
    expect(d.first).toBe(ms('2026-07-11T03:00:00Z'));
    expect(d.firstTracked).toBe(ms('2026-07-11T04:30:00Z'));
    expect(d.invalidated).toBe(30 * MIN);
    expect(d.manual).toBe(H);
    expect(d.worked).toBe(1.5 * H);
  });

  it('buckets a 23-hour DST day by its real window', () => {
    const tz = 'America/New_York';
    const win = localDayWindowInTimeZone('2026-03-08', tz)!;
    expect(win.end.getTime() - win.start.getTime()).toBe(23 * H);
    const pieces = resolveTimeline(
      [entry('w', [['WORK', win.start.toISOString(), win.end.toISOString()]])],
      { now: at('2026-04-01T00:00:00Z'), trustOpenSegments: true },
    );
    expect(bucketByDay(pieces, tz, ['2026-03-08']).get('u1')!.get('2026-03-08')!.counted).toBe(23 * H);
  });
});

describe('localDayWindowInTimeZone on a day whose midnight does not exist', () => {
  it('starts the day at its first real instant', () => {
    // Chile springs forward at 00:00 on 2026-09-06: the day starts at 01:00 local.
    const win = localDayWindowInTimeZone('2026-09-06', 'America/Santiago');
    expect(win).not.toBeNull();
    expect(win!.start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(win!.end.getTime() - win!.start.getTime()).toBe(23 * H);
    // And the previous day ends exactly there.
    expect(localDayWindowInTimeZone('2026-09-05', 'America/Santiago')!.end.toISOString())
      .toBe('2026-09-06T04:00:00.000Z');
  });
});

describe('shiftWindowFor', () => {
  const day = { start: '09:00', end: '18:00' };
  const week = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: null, sun: null };
  const late = { start: '13:00', end: '22:00' };
  const lateWeek = { mon: late, tue: late, wed: late, thu: late, fri: late, sat: null, sun: null };

  it('uses the assignment in force on that date', () => {
    const assignments = [
      { shiftId: 's-day', effectiveFrom: at('2026-01-01T00:00:00Z'), effectiveTo: at('2026-07-13T00:00:00Z'), shiftNameSnapshot: 'Day', scheduleSnapshot: week },
      { shiftId: 's-late', effectiveFrom: at('2026-07-13T00:00:00Z'), effectiveTo: null, shiftNameSnapshot: 'Late', scheduleSnapshot: lateWeek },
    ];
    expect(shiftWindowFor(assignments, '2026-07-10', 'UTC')!.name).toBe('Day');
    expect(shiftWindowFor(assignments, '2026-07-13', 'UTC')!.start).toBe('13:00');
    expect(assignmentForDate(assignments, '2026-07-14', 'UTC')!.shiftId).toBe('s-late');
    expect(shiftWindowFor(assignments, '2026-07-11', 'UTC')).toBeNull(); // Saturday off
  });

  it('runs a night shift into the next calendar day', () => {
    const night = { start: '22:00', end: '06:00' };
    const nightWeek = { mon: night, tue: night, wed: night, thu: night, fri: night, sat: null, sun: null };
    const w = shiftWindowFor(
      [{ shiftId: 's', effectiveFrom: at('2026-01-01T00:00:00Z'), effectiveTo: null, scheduleSnapshot: nightWeek }],
      '2026-07-10',
      'Asia/Kolkata',
    )!;
    expect(w.overnight).toBe(true);
    expect(new Date(w.startMs).toISOString()).toBe('2026-07-10T16:30:00.000Z');
    expect(new Date(w.endMs).toISOString()).toBe('2026-07-11T00:30:00.000Z');
  });

  it('starts a shift scheduled inside a DST gap at the end of the gap', () => {
    const gap = { start: '02:30', end: '10:00' };
    const w = shiftWindowFor(
      [{ shiftId: 's', effectiveFrom: at('2026-01-01T00:00:00Z'), effectiveTo: null, scheduleSnapshot: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: gap } }],
      '2026-03-08',
      'America/New_York',
    )!;
    expect(new Date(w.startMs).toISOString()).toBe('2026-03-08T07:00:00.000Z'); // 03:00 EDT
  });
});

describe('late rule', () => {
  const shiftStartMs = ms('2026-07-10T03:30:00Z'); // 09:00 IST

  it('uses the company grace (30 minutes by default)', () => {
    expect(DEFAULT_LATE_GRACE_MINUTES).toBe(30);
    expect(isLate({ firstTrackedMs: shiftStartMs + 30 * MIN, shiftStartMs })).toBe(false);
    expect(isLate({ firstTrackedMs: shiftStartMs + 31 * MIN, shiftStartMs })).toBe(true);
    expect(isLate({ firstTrackedMs: shiftStartMs + 31 * MIN, shiftStartMs, graceMinutes: 45 })).toBe(false);
  });

  it('is never late without tracked activity or without a shift', () => {
    expect(isLate({ firstTrackedMs: null, shiftStartMs })).toBe(false);
    expect(isLate({ firstTrackedMs: shiftStartMs + 3 * H, shiftStartMs: null })).toBe(false);
  });

  it('is never late on leave, holidays or first-half leave — but can be on second-half leave', () => {
    const lateStart = shiftStartMs + 2 * H;
    const facts = (kind: string, portion: string | null) => ({
      firstTrackedMs: lateStart,
      shiftStartMs,
      status: { kind, portion } as never,
    });
    expect(isLate(facts('HOLIDAY', null))).toBe(false);
    expect(isLate(facts('WEEKLY_OFF', null))).toBe(false);
    expect(isLate(facts('PAID_LEAVE', 'FULL'))).toBe(false);
    expect(isLate(facts('UNPAID_LEAVE', 'FULL'))).toBe(false);
    expect(isLate(facts('PAID_LEAVE', 'FIRST_HALF'))).toBe(false);
    expect(isLate(facts('PAID_LEAVE', 'SECOND_HALF'))).toBe(true);
    expect(isLate(facts('WORKING', null))).toBe(true);
    expect(lateExempt(null)).toBe(false);
  });

  it('labels the day the same way the rule does', () => {
    expect(shiftStatusFor({ shiftStartMs, firstTrackedMs: shiftStartMs - MIN, countedMs: H })).toBe('early');
    expect(shiftStatusFor({ shiftStartMs, firstTrackedMs: shiftStartMs + 10 * MIN, countedMs: H })).toBe('on_time');
    expect(shiftStatusFor({ shiftStartMs, firstTrackedMs: shiftStartMs + H, countedMs: H })).toBe('late');
    expect(shiftStatusFor({ shiftStartMs, firstTrackedMs: null, countedMs: 0 })).toBe('no_activity');
    expect(shiftStatusFor({ shiftStartMs: null, firstTrackedMs: null, countedMs: 0 })).toBe('no_shift');
    expect(shiftStatusFor({
      shiftStartMs,
      firstTrackedMs: shiftStartMs + H,
      countedMs: H,
      status: { kind: 'HOLIDAY', portion: null, expectedFraction: 0 },
    })).toBe('on_time');
  });
});

describe('day thresholds', () => {
  it('full day is 7h and half day is 3h30', () => {
    expect(FULL_DAY_MINUTES).toBe(420);
    expect(HALF_DAY_MINUTES).toBe(210);
    expect(dayCredit(420)).toBe('FULL');
    expect(dayCredit(419)).toBe('HALF');
    expect(dayCredit(210)).toBe('HALF');
    expect(dayCredit(209)).toBe('NONE');
  });
});
