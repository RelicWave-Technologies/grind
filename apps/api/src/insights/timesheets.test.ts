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
