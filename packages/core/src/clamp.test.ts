import { describe, it, expect } from 'vitest';
import { clampEntryToServerClock, DEFAULT_CLOCK_SKEW_MS } from './clamp';
import type { TimeEntry } from './types';

const NOW = 1_700_000_000_000;
const MIN = 60 * 1000;

function entry(partial: Partial<TimeEntry> & { segments: TimeEntry['segments'] }): TimeEntry {
  return {
    id: 'e1',
    clientUuid: 'cu1',
    userId: 'u1',
    source: 'AUTO',
    revision: partial.revision ?? 1,
    startedAt: partial.startedAt ?? NOW - 10 * MIN,
    endedAt: partial.endedAt ?? null,
    pauseReason: partial.pauseReason ?? null,
    closeReason: partial.closeReason ?? null,
    segments: partial.segments,
  };
}

describe('clampEntryToServerClock', () => {
  it('leaves an honest past entry untouched', () => {
    const e = entry({
      startedAt: NOW - 10 * MIN,
      endedAt: NOW - 1 * MIN,
      segments: [{ id: 's1', kind: 'WORK', startedAt: NOW - 10 * MIN, endedAt: NOW - 1 * MIN }],
    });
    const r = clampEntryToServerClock(e, NOW);
    expect(r.adjusted).toBe(false);
    expect(r.notes).toEqual([]);
    expect(r.entry).toEqual(e);
  });

  it('clamps a future segment end down to the ceiling (fast client clock)', () => {
    // Client clock 1h ahead: segment claims it ends an hour in the future.
    const e = entry({
      startedAt: NOW - 5 * MIN,
      endedAt: NOW + 60 * MIN,
      segments: [{ id: 's1', kind: 'WORK', startedAt: NOW - 5 * MIN, endedAt: NOW + 60 * MIN }],
    });
    const r = clampEntryToServerClock(e, NOW);
    expect(r.adjusted).toBe(true);
    const ceiling = NOW + DEFAULT_CLOCK_SKEW_MS;
    expect(r.entry.segments[0]!.endedAt).toBe(ceiling);
    expect(r.entry.endedAt).toBe(ceiling);
    // The honest start is preserved.
    expect(r.entry.segments[0]!.startedAt).toBe(NOW - 5 * MIN);
  });

  it('allows timestamps within the skew window (benign drift)', () => {
    const within = NOW + DEFAULT_CLOCK_SKEW_MS - 1; // just inside the ceiling
    const e = entry({
      startedAt: NOW - 5 * MIN,
      endedAt: within,
      segments: [{ id: 's1', kind: 'WORK', startedAt: NOW - 5 * MIN, endedAt: within }],
    });
    const r = clampEntryToServerClock(e, NOW);
    expect(r.adjusted).toBe(false);
    expect(r.entry.segments[0]!.endedAt).toBe(within);
  });

  it('never touches past (slow client clock under-credits — safe)', () => {
    const e = entry({
      startedAt: NOW - 100 * MIN,
      endedAt: NOW - 50 * MIN,
      segments: [{ id: 's1', kind: 'WORK', startedAt: NOW - 100 * MIN, endedAt: NOW - 50 * MIN }],
    });
    const r = clampEntryToServerClock(e, NOW);
    expect(r.adjusted).toBe(false);
  });

  it('keeps an open (null-ended) segment open, clamping a future start', () => {
    const e = entry({
      startedAt: NOW + 30 * MIN,
      endedAt: null,
      segments: [{ id: 's1', kind: 'WORK', startedAt: NOW + 30 * MIN, endedAt: null }],
    });
    const r = clampEntryToServerClock(e, NOW);
    const ceiling = NOW + DEFAULT_CLOCK_SKEW_MS;
    expect(r.entry.segments[0]!.startedAt).toBe(ceiling);
    expect(r.entry.segments[0]!.endedAt).toBeNull();
    expect(r.adjusted).toBe(true);
  });

  it('drops a segment that becomes zero-length after clamping', () => {
    // Both start and end are far in the future → both clamp to ceiling → zero span.
    const e = entry({
      startedAt: NOW + 30 * MIN,
      endedAt: NOW + 90 * MIN,
      segments: [{ id: 's1', kind: 'WORK', startedAt: NOW + 30 * MIN, endedAt: NOW + 90 * MIN }],
    });
    const r = clampEntryToServerClock(e, NOW);
    expect(r.entry.segments).toHaveLength(0);
    expect(r.notes.some((n) => n.includes('dropped'))).toBe(true);
  });

  it('clamps only the offending segment in a mixed set', () => {
    const e = entry({
      startedAt: NOW - 20 * MIN,
      endedAt: NOW + 60 * MIN,
      segments: [
        { id: 's1', kind: 'WORK', startedAt: NOW - 20 * MIN, endedAt: NOW - 15 * MIN }, // honest
        { id: 's2', kind: 'MEETING', startedAt: NOW - 10 * MIN, endedAt: NOW + 60 * MIN }, // future end
      ],
    });
    const r = clampEntryToServerClock(e, NOW);
    expect(r.entry.segments[0]).toEqual(e.segments[0]); // untouched
    expect(r.entry.segments[1]!.endedAt).toBe(NOW + DEFAULT_CLOCK_SKEW_MS);
  });

  it('respects a custom skew of 0 (strict ceiling = now)', () => {
    const e = entry({
      startedAt: NOW - 5 * MIN,
      endedAt: NOW + 1,
      segments: [{ id: 's1', kind: 'WORK', startedAt: NOW - 5 * MIN, endedAt: NOW + 1 }],
    });
    const r = clampEntryToServerClock(e, NOW, 0);
    expect(r.entry.segments[0]!.endedAt).toBe(NOW);
    expect(r.adjusted).toBe(true);
  });

  it('does not mutate the input entry', () => {
    const e = entry({
      startedAt: NOW - 5 * MIN,
      endedAt: NOW + 60 * MIN,
      segments: [{ id: 's1', kind: 'WORK', startedAt: NOW - 5 * MIN, endedAt: NOW + 60 * MIN }],
    });
    const snapshot = JSON.stringify(e);
    clampEntryToServerClock(e, NOW);
    expect(JSON.stringify(e)).toBe(snapshot);
  });
});
