import { describe, expect, it } from 'vitest';
import { CLAIM_PRIORITY, freeSlices, resolveOverlaps, unionMs } from './overlap';

const MIN = 60_000;
/** Minutes past an arbitrary epoch — short to write, easy to read in failures. */
const t = (m: number) => m * MIN;

interface Block { startedAt: number; endedAt: number; kind: 'WORK' | 'MEETING' | 'MANUAL'; id?: string }
const block = (kind: Block['kind'], from: number, to: number, id?: string): Block =>
  ({ kind, startedAt: t(from), endedAt: t(to), ...(id ? { id } : {}) });

const byPriority = (b: Block) =>
  (b.kind === 'MANUAL' ? CLAIM_PRIORITY.manual : CLAIM_PRIORITY.tracked);

const spans = (out: Block[]) => out.map((b) => [b.kind, b.startedAt / MIN, b.endedAt / MIN]);

describe('resolveOverlaps', () => {
  it('leaves entries that do not touch alone', () => {
    const out = resolveOverlaps([block('WORK', 0, 10), block('MANUAL', 20, 30)], byPriority);
    expect(spans(out)).toEqual([['WORK', 0, 10], ['MANUAL', 20, 30]]);
  });

  it('drops a manual claim that sits entirely inside tracked time', () => {
    // The reported case: tracked 10:40-11:37 with manual 10:45-11:37 on top.
    // Those 52 minutes were already counted once; the claim adds nothing.
    const out = resolveOverlaps([block('WORK', 40, 97), block('MANUAL', 45, 97)], byPriority);
    expect(spans(out)).toEqual([['WORK', 40, 97]]);
  });

  it('keeps the part of a manual claim that spills past tracked time', () => {
    const out = resolveOverlaps([block('WORK', 0, 30), block('MANUAL', 20, 50)], byPriority);
    expect(spans(out)).toEqual([['WORK', 0, 30], ['MANUAL', 30, 50]]);
  });

  it('keeps both sides when a manual claim brackets a tracked stretch', () => {
    const out = resolveOverlaps([block('WORK', 20, 30), block('MANUAL', 10, 40)], byPriority);
    expect(spans(out)).toEqual([['MANUAL', 10, 20], ['WORK', 20, 30], ['MANUAL', 30, 40]]);
  });

  it('splits a manual claim around two tracked stretches', () => {
    const out = resolveOverlaps(
      [block('WORK', 10, 20), block('WORK', 30, 40), block('MANUAL', 0, 50)],
      byPriority,
    );
    expect(spans(out)).toEqual([
      ['MANUAL', 0, 10], ['WORK', 10, 20], ['MANUAL', 20, 30], ['WORK', 30, 40], ['MANUAL', 40, 50],
    ]);
  });

  it('treats meetings as tracked, not as something manual can displace', () => {
    const out = resolveOverlaps([block('MEETING', 0, 30), block('MANUAL', 10, 20)], byPriority);
    expect(spans(out)).toEqual([['MEETING', 0, 30]]);
  });

  it('gives contested minutes to the earlier of two equal-priority entries', () => {
    // Two tracked segments should never contend; if they do, first one wins —
    // the same rule the sync layer uses when two devices claim one period.
    const out = resolveOverlaps([block('WORK', 0, 20, 'a'), block('WORK', 10, 30, 'b')], byPriority);
    expect(spans(out)).toEqual([['WORK', 0, 20], ['WORK', 20, 30]]);
    expect(out.map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('does not depend on input order', () => {
    const items = [block('MANUAL', 0, 50), block('WORK', 10, 20), block('WORK', 30, 40)];
    const forward = spans(resolveOverlaps(items, byPriority));
    const backward = spans(resolveOverlaps([...items].reverse(), byPriority));
    expect(backward).toEqual(forward);
  });

  it('carries the original fields through onto every surviving piece', () => {
    const out = resolveOverlaps([block('WORK', 20, 30), block('MANUAL', 10, 40, 'req-1')], byPriority);
    const manual = out.filter((b) => b.kind === 'MANUAL');
    expect(manual).toHaveLength(2);
    expect(manual.every((b) => b.id === 'req-1')).toBe(true);
  });

  it('never invents or loses covered time', () => {
    const items = [
      block('WORK', 0, 25), block('MANUAL', 10, 40), block('MEETING', 35, 50), block('MANUAL', 45, 60),
    ];
    const out = resolveOverlaps(items, byPriority);
    // Same covered span as the inputs, and the pieces themselves never overlap.
    expect(unionMs(out)).toBe(unionMs(items));
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]!.startedAt).toBeGreaterThanOrEqual(out[i - 1]!.endedAt);
    }
  });

  it('discards zero-length and inverted input', () => {
    const out = resolveOverlaps(
      [block('WORK', 10, 10), { kind: 'MANUAL', startedAt: t(30), endedAt: t(20) }, block('WORK', 0, 5)],
      byPriority,
    );
    expect(spans(out)).toEqual([['WORK', 0, 5]]);
  });
});

describe('freeSlices', () => {
  it('returns nothing when the request is fully covered', () => {
    expect(freeSlices({ startedAt: t(45), endedAt: t(97) }, [{ startedAt: t(40), endedAt: t(97) }]))
      .toEqual([]);
  });

  it('returns the uncovered head and tail', () => {
    const out = freeSlices({ startedAt: t(0), endedAt: t(60) }, [
      { startedAt: t(10), endedAt: t(20) },
      { startedAt: t(40), endedAt: t(50) },
    ]);
    expect(out.map((s) => [s.startedAt / MIN, s.endedAt / MIN]))
      .toEqual([[0, 10], [20, 40], [50, 60]]);
  });

  it('handles unsorted and overlapping occupied spans', () => {
    const out = freeSlices({ startedAt: t(0), endedAt: t(60) }, [
      { startedAt: t(40), endedAt: t(50) },
      { startedAt: t(10), endedAt: t(20) },
      { startedAt: t(15), endedAt: t(45) },
    ]);
    expect(out.map((s) => [s.startedAt / MIN, s.endedAt / MIN])).toEqual([[0, 10], [50, 60]]);
  });

  it('returns the whole span when nothing is occupied', () => {
    expect(freeSlices({ startedAt: t(0), endedAt: t(30) }, []))
      .toEqual([{ startedAt: t(0), endedAt: t(30) }]);
  });
});

describe('unionMs', () => {
  it('counts a covered instant once however many spans cover it', () => {
    // 58m tracked + 52m manual on the same 57m of clock is 57m of work.
    expect(unionMs([
      { startedAt: t(40), endedAt: t(97) },
      { startedAt: t(45), endedAt: t(97) },
    ])).toBe(57 * MIN);
  });

  it('adds disjoint spans', () => {
    expect(unionMs([
      { startedAt: t(0), endedAt: t(10) },
      { startedAt: t(20), endedAt: t(25) },
    ])).toBe(15 * MIN);
  });

  it('joins spans that merely touch', () => {
    expect(unionMs([
      { startedAt: t(0), endedAt: t(10) },
      { startedAt: t(10), endedAt: t(20) },
    ])).toBe(20 * MIN);
  });
});
