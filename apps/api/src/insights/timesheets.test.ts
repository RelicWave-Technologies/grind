import { describe, it, expect } from 'vitest';
import { buildTimesheetMatrix, dateRange, addDays } from './timesheets';

/** Build a fake segment for terseness. */
function seg(
  userId: string,
  source: 'AUTO' | 'MANUAL',
  segmentKind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
  startedAt: string,
  endedAt: string,
) {
  return {
    userId,
    source,
    segmentKind,
    startedAt: new Date(startedAt).getTime(),
    endedAt: new Date(endedAt).getTime(),
  };
}

describe('dateRange + addDays', () => {
  it('addDays handles month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('dateRange is inclusive on both ends', () => {
    expect(dateRange('2026-05-25', '2026-05-27')).toEqual(['2026-05-25', '2026-05-26', '2026-05-27']);
  });
  it('dateRange single-day collapses to one entry', () => {
    expect(dateRange('2026-05-25', '2026-05-25')).toEqual(['2026-05-25']);
  });
});

describe('buildTimesheetMatrix — UTC tz, single-user', () => {
  it('one WORK segment lands on its day with the right duration', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [seg('u1', 'AUTO', 'WORK', '2026-05-25T09:00:00Z', '2026-05-25T10:30:00Z')],
    });
    expect(m).not.toBeNull();
    expect(m!.days).toEqual(['2026-05-25']);
    expect(m!.cells.u1?.['2026-05-25']?.workedMs).toBe(90 * 60 * 1000);
    expect(m!.cells.u1?.['2026-05-25']?.totalMs).toBe(90 * 60 * 1000);
  });

  it('MEETING goes to meetingMs, WORK to workedMs, both contribute to total', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [
        seg('u1', 'AUTO', 'WORK', '2026-05-25T09:00:00Z', '2026-05-25T10:00:00Z'),
        seg('u1', 'AUTO', 'MEETING', '2026-05-25T11:00:00Z', '2026-05-25T11:30:00Z'),
      ],
    });
    const cell = m!.cells.u1!['2026-05-25']!;
    expect(cell.workedMs).toBe(60 * 60 * 1000);
    expect(cell.meetingMs).toBe(30 * 60 * 1000);
    expect(cell.totalMs).toBe(90 * 60 * 1000);
  });

  it('MANUAL source collapses to manualMs regardless of segment.kind', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [seg('u1', 'MANUAL', 'WORK', '2026-05-25T14:00:00Z', '2026-05-25T15:00:00Z')],
    });
    const cell = m!.cells.u1!['2026-05-25']!;
    expect(cell.manualMs).toBe(60 * 60 * 1000);
    expect(cell.workedMs).toBe(0);
    expect(cell.totalMs).toBe(60 * 60 * 1000);
  });

  it('IDLE_TRIMMED contributes nothing (that is the point of trimming)', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [seg('u1', 'AUTO', 'IDLE_TRIMMED', '2026-05-25T09:00:00Z', '2026-05-25T09:30:00Z')],
    });
    expect(m!.cells.u1).toBeUndefined();
  });

  it('a segment crossing midnight is split across both days correctly', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-26',
      tz: 'UTC',
      segments: [seg('u1', 'AUTO', 'WORK', '2026-05-25T23:00:00Z', '2026-05-26T01:00:00Z')],
    });
    expect(m!.cells.u1?.['2026-05-25']?.workedMs).toBe(60 * 60 * 1000);
    expect(m!.cells.u1?.['2026-05-26']?.workedMs).toBe(60 * 60 * 1000);
  });

  it('segments outside the range are dropped, never counted', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [
        seg('u1', 'AUTO', 'WORK', '2026-05-24T09:00:00Z', '2026-05-24T10:00:00Z'),
        seg('u1', 'AUTO', 'WORK', '2026-05-26T09:00:00Z', '2026-05-26T10:00:00Z'),
      ],
    });
    expect(m!.cells).toEqual({});
  });
});

describe('buildTimesheetMatrix — multi-user, multi-day', () => {
  it('keeps users independent', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [
        seg('alice', 'AUTO', 'WORK', '2026-05-25T09:00:00Z', '2026-05-25T10:00:00Z'),
        seg('bob', 'AUTO', 'WORK', '2026-05-25T14:00:00Z', '2026-05-25T15:30:00Z'),
      ],
    });
    expect(m!.cells.alice?.['2026-05-25']?.workedMs).toBe(60 * 60 * 1000);
    expect(m!.cells.bob?.['2026-05-25']?.workedMs).toBe(90 * 60 * 1000);
  });

  it('returns the full day list even when a day has no activity (rendering relies on it)', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-27',
      tz: 'UTC',
      segments: [seg('u1', 'AUTO', 'WORK', '2026-05-26T09:00:00Z', '2026-05-26T10:00:00Z')],
    });
    expect(m!.days).toEqual(['2026-05-25', '2026-05-26', '2026-05-27']);
    expect(m!.cells.u1?.['2026-05-26']?.workedMs).toBe(60 * 60 * 1000);
    expect(m!.cells.u1?.['2026-05-25']).toBeUndefined();
    expect(m!.cells.u1?.['2026-05-27']).toBeUndefined();
  });
});

describe('buildTimesheetMatrix — firstActivityMs / lastActivityMs', () => {
  it('records the earliest and latest tracked moment in the cell', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [
        seg('u1', 'AUTO', 'WORK', '2026-05-25T11:00:00Z', '2026-05-25T11:30:00Z'),
        seg('u1', 'AUTO', 'WORK', '2026-05-25T09:15:00Z', '2026-05-25T09:45:00Z'),
        seg('u1', 'AUTO', 'MEETING', '2026-05-25T17:00:00Z', '2026-05-25T18:00:00Z'),
      ],
    });
    const cell = m!.cells.u1!['2026-05-25']!;
    expect(cell.firstActivityMs).toBe(new Date('2026-05-25T09:15:00Z').getTime());
    expect(cell.lastActivityMs).toBe(new Date('2026-05-25T18:00:00Z').getTime());
  });

  it('IDLE_TRIMMED does not advance first/last (it is not real activity)', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [
        seg('u1', 'AUTO', 'IDLE_TRIMMED', '2026-05-25T07:00:00Z', '2026-05-25T08:00:00Z'),
        seg('u1', 'AUTO', 'WORK', '2026-05-25T10:00:00Z', '2026-05-25T10:30:00Z'),
        seg('u1', 'AUTO', 'IDLE_TRIMMED', '2026-05-25T22:00:00Z', '2026-05-25T23:00:00Z'),
      ],
    });
    const cell = m!.cells.u1!['2026-05-25']!;
    expect(cell.firstActivityMs).toBe(new Date('2026-05-25T10:00:00Z').getTime());
    expect(cell.lastActivityMs).toBe(new Date('2026-05-25T10:30:00Z').getTime());
  });

  it('clipped midnight-crossing segments use clipped boundaries, not the raw segment ends', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-26',
      tz: 'UTC',
      segments: [seg('u1', 'AUTO', 'WORK', '2026-05-25T23:00:00Z', '2026-05-26T02:00:00Z')],
    });
    expect(m!.cells.u1!['2026-05-25']!.firstActivityMs).toBe(new Date('2026-05-25T23:00:00Z').getTime());
    expect(m!.cells.u1!['2026-05-25']!.lastActivityMs).toBe(new Date('2026-05-26T00:00:00Z').getTime());
    expect(m!.cells.u1!['2026-05-26']!.firstActivityMs).toBe(new Date('2026-05-26T00:00:00Z').getTime());
    expect(m!.cells.u1!['2026-05-26']!.lastActivityMs).toBe(new Date('2026-05-26T02:00:00Z').getTime());
  });
});

describe('buildTimesheetMatrix — invalidations', () => {
  it('subtracts invalidated overlaps and exposes invalidatedMs', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [seg('u1', 'AUTO', 'WORK', '2026-05-25T09:00:00Z', '2026-05-25T10:00:00Z')],
      invalidations: [
        {
          userId: 'u1',
          startedAt: new Date('2026-05-25T09:15:00Z').getTime(),
          endedAt: new Date('2026-05-25T09:45:00Z').getTime(),
        },
      ],
    });
    const cell = m!.cells.u1!['2026-05-25']!;
    expect(cell.workedMs).toBe(30 * 60 * 1000);
    expect(cell.invalidatedMs).toBe(30 * 60 * 1000);
    expect(cell.totalMs).toBe(30 * 60 * 1000);
    expect(cell.firstActivityMs).toBe(new Date('2026-05-25T09:00:00Z').getTime());
    expect(cell.lastActivityMs).toBe(new Date('2026-05-25T10:00:00Z').getTime());
  });

  it('merges overlapping invalidations so excluded time is not double-counted', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [seg('u1', 'AUTO', 'WORK', '2026-05-25T09:00:00Z', '2026-05-25T10:00:00Z')],
      invalidations: [
        {
          userId: 'u1',
          startedAt: new Date('2026-05-25T09:10:00Z').getTime(),
          endedAt: new Date('2026-05-25T09:40:00Z').getTime(),
        },
        {
          userId: 'u1',
          startedAt: new Date('2026-05-25T09:30:00Z').getTime(),
          endedAt: new Date('2026-05-25T09:50:00Z').getTime(),
        },
      ],
    });
    const cell = m!.cells.u1!['2026-05-25']!;
    expect(cell.workedMs).toBe(20 * 60 * 1000);
    expect(cell.invalidatedMs).toBe(40 * 60 * 1000);
  });

  it('keeps invalidations scoped to the matching user', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [seg('u1', 'AUTO', 'WORK', '2026-05-25T09:00:00Z', '2026-05-25T10:00:00Z')],
      invalidations: [
        {
          userId: 'u2',
          startedAt: new Date('2026-05-25T09:00:00Z').getTime(),
          endedAt: new Date('2026-05-25T10:00:00Z').getTime(),
        },
      ],
    });
    const cell = m!.cells.u1!['2026-05-25']!;
    expect(cell.workedMs).toBe(60 * 60 * 1000);
    expect(cell.invalidatedMs).toBe(0);
  });

  it('splits invalidated time across local days', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-26',
      tz: 'UTC',
      segments: [seg('u1', 'AUTO', 'WORK', '2026-05-25T23:30:00Z', '2026-05-26T00:30:00Z')],
      invalidations: [
        {
          userId: 'u1',
          startedAt: new Date('2026-05-25T23:45:00Z').getTime(),
          endedAt: new Date('2026-05-26T00:15:00Z').getTime(),
        },
      ],
    });
    expect(m!.cells.u1!['2026-05-25']!.workedMs).toBe(15 * 60 * 1000);
    expect(m!.cells.u1!['2026-05-25']!.invalidatedMs).toBe(15 * 60 * 1000);
    expect(m!.cells.u1!['2026-05-26']!.workedMs).toBe(15 * 60 * 1000);
    expect(m!.cells.u1!['2026-05-26']!.invalidatedMs).toBe(15 * 60 * 1000);
  });
});

describe('buildTimesheetMatrix — tz handling', () => {
  it('a UTC-midnight segment in America/New_York lands on the *previous* local day', () => {
    // 2026-05-26T03:00Z = 2026-05-25 23:00 EDT.
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-26',
      tz: 'America/New_York',
      segments: [seg('u1', 'AUTO', 'WORK', '2026-05-26T01:00:00Z', '2026-05-26T03:00:00Z')],
    });
    // 21:00 EDT → 23:00 EDT, both still on May 25 in NY.
    expect(m!.cells.u1?.['2026-05-25']?.workedMs).toBe(2 * 60 * 60 * 1000);
    expect(m!.cells.u1?.['2026-05-26']).toBeUndefined();
  });

  it('rejects invalid tz', () => {
    const m = buildTimesheetMatrix({
      from: '2026-05-25',
      to: '2026-05-25',
      tz: 'Not/A/Real/Zone',
      segments: [],
    });
    expect(m).toBeNull();
  });

  it('rejects invalid date strings', () => {
    const m = buildTimesheetMatrix({
      from: 'not-a-date',
      to: '2026-05-25',
      tz: 'UTC',
      segments: [],
    });
    expect(m).toBeNull();
  });
});
