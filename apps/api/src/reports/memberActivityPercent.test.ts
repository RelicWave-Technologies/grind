import { describe, expect, it } from 'vitest';
import { buildMemberReportScreenshots, type ReportActivitySample, type ReportRange, type ReportTimeEntry } from './member';

const DAY = '2026-06-01';
const T0 = Date.UTC(2026, 5, 1, 9, 0);
const MIN = 60_000;
const range: ReportRange = {
  from: DAY,
  to: DAY,
  tz: 'UTC',
  days: [DAY],
  rangeStart: new Date(Date.UTC(2026, 5, 1)),
  rangeEnd: new Date(Date.UTC(2026, 5, 2)),
};

/** A minute at full intensity for the default role. */
function busyMinute(at: number): ReportActivitySample {
  return {
    timeEntryId: 'e1',
    bucketStart: new Date(at),
    keystrokes: 10_000,
    clicks: 10_000,
    scrollEvents: 10_000,
    mouseDistancePx: 1_000_000,
    activeApp: null,
    activeAppBundle: null,
  };
}

function workEntry(minutes: number): ReportTimeEntry {
  return {
    id: 'e1',
    userId: 'u1',
    source: 'AUTO',
    larkTaskGuid: null,
    notes: null,
    endedAt: new Date(T0 + minutes * MIN),
    segments: [{ kind: 'WORK', startedAt: new Date(T0), endedAt: new Date(T0 + minutes * MIN) }],
    attendees: [],
  };
}

function percent(samples: ReportActivitySample[], entries?: ReportTimeEntry[]) {
  return buildMemberReportScreenshots({
    userId: 'u1',
    range,
    samples,
    screenshots: [],
    entries,
    now: new Date(T0 + 24 * 60 * MIN),
    toUrl: () => null,
  }).activityPercent;
}

describe('member report activity percent', () => {
  it('averages over tracked minutes: one busy minute in ten is 10%', () => {
    expect(percent([busyMinute(T0)], [workEntry(10)])).toBe(10);
  });

  it('counts stored zero minutes the same way', () => {
    const quiet = Array.from({ length: 9 }, (_, i) => ({ ...busyMinute(T0 + (i + 1) * MIN), keystrokes: 0, clicks: 0, scrollEvents: 0, mouseDistancePx: 0 }));
    expect(percent([busyMinute(T0), ...quiet], [workEntry(10)])).toBe(10);
  });

  it('falls back to stored samples without timer data, and is null without samples', () => {
    expect(percent([busyMinute(T0)])).toBe(100);
    expect(percent([], [workEntry(10)])).toBeNull();
  });
});
