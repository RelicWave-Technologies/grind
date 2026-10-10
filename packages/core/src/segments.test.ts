import { describe, it, expect } from 'vitest';
import {
  closeOpenSegment,
  closeTimeEntry,
  createTimeEntry,
  dropZeroLengthSegments,
  getOpenSegment,
  isZeroLengthSegment,
  openSegment,
  recoverStaleEntry,
  SegmentError,
  totalIdleTrimmedMs,
  totalWorkedMs,
  validateEntry,
  type TimeEntry,
} from './index';

// Fixed epoch anchors (ms) for readable assertions.
const T0 = 1_700_000_000_000;
const MIN = 60_000;

function baseEntry(startedAt = T0): TimeEntry {
  return createTimeEntry({
    id: 'te_1',
    clientUuid: 'uuid_1',
    userId: 'u_1',
    startedAt,
    segmentId: 's_1',
  });
}

describe('createTimeEntry', () => {
  it('creates a running entry with one open WORK segment', () => {
    const e = baseEntry();
    expect(e.endedAt).toBeNull();
    expect(e.segments).toHaveLength(1);
    expect(e.segments[0]).toMatchObject({ id: 's_1', kind: 'WORK', startedAt: T0, endedAt: null });
    expect(e.source).toBe('AUTO');
    expect(e.larkTaskGuid).toBeNull();
    expect(validateEntry(e)).toEqual([]);
  });

  it('honors explicit source and Lark task attribution', () => {
    const e = createTimeEntry({
      id: 'te', clientUuid: 'u', userId: 'u1',
      larkTaskGuid: 'guid_xyz', source: 'MANUAL', startedAt: T0, segmentId: 's',
    });
    expect(e.source).toBe('MANUAL');
    expect(e.larkTaskGuid).toBe('guid_xyz');
  });
});

describe('closeOpenSegment', () => {
  it('closes the open segment', () => {
    const e = closeOpenSegment(baseEntry(), T0 + 10 * MIN);
    expect(e.segments[0]!.endedAt).toBe(T0 + 10 * MIN);
    expect(getOpenSegment(e)).toBeNull();
    expect(validateEntry(e)).toEqual([]);
  });

  it('is a no-op (idempotent) when nothing is open', () => {
    const closed = closeOpenSegment(baseEntry(), T0 + MIN);
    const again = closeOpenSegment(closed, T0 + 5 * MIN);
    expect(again).toEqual(closed);
  });

  it('throws when closing before the segment start', () => {
    expect(() => closeOpenSegment(baseEntry(T0), T0 - 1)).toThrow(SegmentError);
  });

  it('does not mutate the input', () => {
    const e = baseEntry();
    const snapshot = JSON.parse(JSON.stringify(e));
    closeOpenSegment(e, T0 + MIN);
    expect(e).toEqual(snapshot);
  });
});

describe('openSegment (transitions)', () => {
  it('closes the current segment and opens a new one of the given kind', () => {
    let e = baseEntry();
    e = openSegment(e, { kind: 'MEETING', at: T0 + 5 * MIN, segmentId: 's_2' });
    expect(e.segments).toHaveLength(2);
    expect(e.segments[0]).toMatchObject({ kind: 'WORK', endedAt: T0 + 5 * MIN });
    expect(e.segments[1]).toMatchObject({ kind: 'MEETING', startedAt: T0 + 5 * MIN, endedAt: null });
    expect(validateEntry(e)).toEqual([]);
  });

  it('supports MEETING -> WORK back-transition', () => {
    let e = baseEntry();
    e = openSegment(e, { kind: 'MEETING', at: T0 + 5 * MIN, segmentId: 's_2' });
    e = openSegment(e, { kind: 'WORK', at: T0 + 20 * MIN, segmentId: 's_3' });
    expect(e.segments.map((s) => s.kind)).toEqual(['WORK', 'MEETING', 'WORK']);
    expect(validateEntry(e)).toEqual([]);
  });

  it('throws when opening on a closed entry', () => {
    const e = closeTimeEntry(baseEntry(), T0 + MIN);
    expect(() => openSegment(e, { kind: 'WORK', at: T0 + 2 * MIN, segmentId: 'x' })).toThrow(SegmentError);
  });
});

describe('closeTimeEntry', () => {
  it('closes the open segment and stamps endedAt', () => {
    const e = closeTimeEntry(baseEntry(), T0 + 30 * MIN);
    expect(e.endedAt).toBe(T0 + 30 * MIN);
    expect(getOpenSegment(e)).toBeNull();
    expect(validateEntry(e)).toEqual([]);
  });

  it('is idempotent', () => {
    const once = closeTimeEntry(baseEntry(), T0 + 30 * MIN);
    const twice = closeTimeEntry(once, T0 + 99 * MIN);
    expect(twice).toEqual(once);
  });
});

describe('totalWorkedMs', () => {
  it('counts a single closed WORK segment', () => {
    const e = closeTimeEntry(baseEntry(), T0 + 10 * MIN);
    expect(totalWorkedMs(e)).toBe(10 * MIN);
  });

  it('counts the open segment up to `now`', () => {
    expect(totalWorkedMs(baseEntry(), T0 + 7 * MIN)).toBe(7 * MIN);
  });

  it('throws if open segment and `now` omitted', () => {
    expect(() => totalWorkedMs(baseEntry())).toThrow(SegmentError);
  });

  it('counts WORK + MEETING but not IDLE_TRIMMED', () => {
    let e = baseEntry(); // WORK from T0
    e = openSegment(e, { kind: 'MEETING', at: T0 + 10 * MIN, segmentId: 's_2' }); // WORK 10m
    e = closeTimeEntry(e, T0 + 25 * MIN); // MEETING 15m
    expect(totalWorkedMs(e)).toBe(25 * MIN);
  });
});

describe('recoverStaleEntry (crash recovery)', () => {
  it('closes an open entry at the last-known-active time', () => {
    const e = recoverStaleEntry(baseEntry(T0), T0 + 12 * MIN);
    expect(e.endedAt).toBe(T0 + 12 * MIN);
    expect(getOpenSegment(e)).toBeNull();
    expect(totalWorkedMs(e)).toBe(12 * MIN);
    expect(validateEntry(e)).toEqual([]);
  });

  it('never produces a negative segment when lastKnownActive precedes start', () => {
    const e = recoverStaleEntry(baseEntry(T0 + 10 * MIN), T0); // lastActive before start
    expect(e.endedAt).toBe(T0 + 10 * MIN); // clamped to segment start
    // ...where the segment would be zero-length, so it is removed instead.
    expect(e.segments).toEqual([]);
    expect(totalWorkedMs(e)).toBe(0);
    expect(validateEntry(e)).toEqual([]);
  });

  it('is a no-op on an already-closed entry', () => {
    const closed = closeTimeEntry(baseEntry(), T0 + MIN);
    expect(recoverStaleEntry(closed, T0 + 99 * MIN)).toEqual(closed);
  });
});

describe('validateEntry (invariant guard)', () => {
  it('flags two open segments', () => {
    const e = baseEntry();
    e.segments.push({ id: 's_bad', kind: 'WORK', startedAt: T0 + MIN, endedAt: null });
    expect(validateEntry(e).join(';')).toMatch(/open segments|not last/);
  });

  it('flags overlapping segments', () => {
    const e: TimeEntry = {
      ...baseEntry(),
      segments: [
        { id: 'a', kind: 'WORK', startedAt: T0, endedAt: T0 + 10 * MIN },
        { id: 'b', kind: 'WORK', startedAt: T0 + 5 * MIN, endedAt: null },
      ],
    };
    expect(validateEntry(e).join(';')).toMatch(/overlaps/);
  });

  it('flags endedAt < startedAt', () => {
    const e: TimeEntry = {
      ...baseEntry(),
      endedAt: T0,
      segments: [{ id: 'a', kind: 'WORK', startedAt: T0 + 10 * MIN, endedAt: T0 }],
    };
    expect(validateEntry(e).join(';')).toMatch(/endedAt.*<.*startedAt/);
  });

  it('flags an entry that starts after its first segment', () => {
    const e = baseEntry();
    e.startedAt = T0 + MIN;
    expect(validateEntry(e).join(';')).toMatch(/entry.startedAt/);
  });

  it('accepts an entry that starts before its first segment (a dropped zero-length start)', () => {
    const e = baseEntry();
    e.startedAt = T0 - MIN;
    expect(validateEntry(e)).toEqual([]);
  });

  it('flags a closed entry that still has an open segment', () => {
    const e = baseEntry();
    e.endedAt = T0 + 10 * MIN; // closed entry but segment still open
    expect(validateEntry(e).join(';')).toMatch(/closed but has an open segment/);
  });

  it('flags duplicate segment ids', () => {
    const e: TimeEntry = {
      ...baseEntry(),
      endedAt: T0 + 20 * MIN,
      segments: [
        { id: 'dup', kind: 'WORK', startedAt: T0, endedAt: T0 + 10 * MIN },
        { id: 'dup', kind: 'WORK', startedAt: T0 + 10 * MIN, endedAt: T0 + 20 * MIN },
      ],
    };
    expect(validateEntry(e).join(';')).toMatch(/duplicate segment id/);
  });

  it('accepts a well-formed multi-segment entry', () => {
    let e = baseEntry();
    e = openSegment(e, { kind: 'MEETING', at: T0 + 10 * MIN, segmentId: 's2' });
    e = closeTimeEntry(e, T0 + 25 * MIN);
    expect(validateEntry(e)).toEqual([]);
  });
});

describe('zero-length segments (one rule, see segments.ts)', () => {
  it('closing a segment at its own start removes it instead of keeping an empty span', () => {
    const e = closeOpenSegment(baseEntry(), T0);
    expect(e.segments).toEqual([]);
    expect(e.revision).toBe(2);
    expect(e.endedAt).toBeNull();
    expect(validateEntry(e)).toEqual([]);
  });

  it('stopping in the same millisecond leaves a closed entry with no segments', () => {
    const e = closeTimeEntry(baseEntry(), T0);
    expect(e.endedAt).toBe(T0);
    expect(e.startedAt).toBe(T0);
    expect(e.segments).toEqual([]);
    expect(totalWorkedMs(e)).toBe(0);
    expect(validateEntry(e)).toEqual([]);
  });

  it('switching segment kind in the same millisecond replaces the empty one', () => {
    const e = openSegment(baseEntry(), { kind: 'MEETING', at: T0, segmentId: 's_2' });
    expect(e.segments.map((s) => s.id)).toEqual(['s_2']);
    expect(validateEntry(e)).toEqual([]);
  });

  it('only the empty segment is removed; earlier work is kept', () => {
    let e = closeOpenSegment(baseEntry(), T0 + 10 * MIN);
    e = openSegment(e, { kind: 'WORK', at: T0 + 20 * MIN, segmentId: 's_2' });
    e = closeTimeEntry(e, T0 + 20 * MIN);
    expect(e.segments.map((s) => s.id)).toEqual(['s_1']);
    expect(e.endedAt).toBe(T0 + 20 * MIN);
    expect(totalWorkedMs(e)).toBe(10 * MIN);
    expect(validateEntry(e)).toEqual([]);
  });

  it('a paused-at-start entry resumes later and still validates', () => {
    let e = closeOpenSegment(baseEntry(), T0); // paused the instant it started
    e = openSegment(e, { kind: 'WORK', at: T0 + 5 * MIN, segmentId: 's_2' });
    expect(e.startedAt).toBe(T0);
    expect(e.segments[0]!.startedAt).toBe(T0 + 5 * MIN);
    expect(validateEntry(e)).toEqual([]);
    expect(totalWorkedMs(e, T0 + 8 * MIN)).toBe(3 * MIN);
  });

  it('validateEntry tolerates a zero-length segment from an older agent', () => {
    const e: TimeEntry = {
      ...baseEntry(),
      endedAt: T0 + 10 * MIN,
      segments: [
        { id: 'z', kind: 'WORK', startedAt: T0, endedAt: T0 },
        { id: 'a', kind: 'WORK', startedAt: T0, endedAt: T0 + 10 * MIN },
      ],
    };
    expect(validateEntry(e)).toEqual([]);
  });

  it('dropZeroLengthSegments removes exactly the empty spans and keeps the revision', () => {
    const e: TimeEntry = {
      ...baseEntry(),
      revision: 7,
      endedAt: T0 + 10 * MIN,
      segments: [
        { id: 'z1', kind: 'WORK', startedAt: T0, endedAt: T0 },
        { id: 'a', kind: 'WORK', startedAt: T0, endedAt: T0 + 10 * MIN },
        { id: 'z2', kind: 'IDLE_TRIMMED', startedAt: T0 + 10 * MIN, endedAt: T0 + 10 * MIN },
      ],
    };
    const r = dropZeroLengthSegments(e);
    expect(r.droppedIds).toEqual(['z1', 'z2']);
    expect(r.entry.segments.map((s) => s.id)).toEqual(['a']);
    expect(r.entry.revision).toBe(7);
    expect(r.entry.startedAt).toBe(T0);
    expect(e.segments).toHaveLength(3); // input untouched
    const clean = closeTimeEntry(baseEntry(), T0 + MIN);
    expect(dropZeroLengthSegments(clean).entry).toBe(clean);
  });

  it('judges zero-length at the wire resolution (sub-millisecond spans vanish)', () => {
    const fractional = createTimeEntry({ id: 'f', clientUuid: 'f', userId: 'u', startedAt: T0 + 0.2, segmentId: 'sf' });
    const e = closeOpenSegment(fractional, T0 + 0.9);
    expect(e.segments).toEqual([]);
    const kept = closeOpenSegment(fractional, T0 + 1.1);
    expect(kept.segments).toHaveLength(1);
  });

  it('an open segment is never zero-length', () => {
    expect(isZeroLengthSegment({ id: 'o', kind: 'WORK', startedAt: T0, endedAt: null })).toBe(false);
    expect(isZeroLengthSegment({ id: 'z', kind: 'WORK', startedAt: T0, endedAt: T0 })).toBe(true);
  });
});
