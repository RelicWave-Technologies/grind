import { describe, it, expect } from 'vitest';
import {
  snapToGrid,
  findBlockAt,
  presetForClick,
  isInsidePendingOverlay,
  windowFor,
  type DayBlockClient,
} from './dayRibbon';

/** Tests for the pure dayRibbon helpers. No DOM, no IPC. */

const ms = (h: number, m = 0) => new Date(`2026-05-30T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`).getTime();
const dayStart = ms(0);
const dayEnd = ms(0) + 24 * 3600 * 1000;
const HOUR = 60 * 60 * 1000;

function gap(s: number, e: number): DayBlockClient {
  return { kind: 'GAP', startedAt: s, endedAt: e, durationMs: e - s };
}
function work(s: number, e: number, guid: string | null = null): DayBlockClient {
  return { kind: 'WORK', startedAt: s, endedAt: e, durationMs: e - s, larkTaskGuid: guid };
}

describe('snapToGrid', () => {
  it('rounds to nearest 5-minute mark', () => {
    expect(snapToGrid(ms(9, 12))).toBe(ms(9, 10));
    expect(snapToGrid(ms(9, 13))).toBe(ms(9, 15));
    expect(snapToGrid(ms(9, 17))).toBe(ms(9, 15));
    expect(snapToGrid(ms(9, 18))).toBe(ms(9, 20));
  });
});

describe('findBlockAt', () => {
  it('finds the block containing `t`, half-open at the right edge', () => {
    const blocks = [work(ms(9), ms(10)), gap(ms(10), ms(11)), work(ms(11), ms(12))];
    expect(findBlockAt(blocks, ms(9, 30))?.kind).toBe('WORK');
    expect(findBlockAt(blocks, ms(10))?.kind).toBe('GAP');
    expect(findBlockAt(blocks, ms(10, 59))?.kind).toBe('GAP');
    expect(findBlockAt(blocks, ms(11))?.kind).toBe('WORK');
    expect(findBlockAt(blocks, ms(13))).toBeNull();
  });
});

describe('presetForClick', () => {
  const now = ms(20); // 8 PM today
  const args = (blocks: DayBlockClient[], clickedAtMs: number) => ({ blocks, clickedAtMs, dayStart, dayEnd, now });

  it('snaps to the full gap when gap is ≤ 4h', () => {
    const blocks = [work(ms(9), ms(10), 't1'), gap(ms(10), ms(11)), work(ms(11), ms(12), 't1')];
    const out = presetForClick(args(blocks, ms(10, 30)));
    expect(out).toEqual({ startedAt: ms(10), endedAt: ms(11), larkTaskGuid: 't1' });
  });

  it('uses a centered 1h window for a long (>4h) gap', () => {
    const blocks = [work(ms(8), ms(9)), gap(ms(9), ms(15)), work(ms(15), ms(16))];
    const out = presetForClick(args(blocks, ms(12)));
    expect(out!.endedAt - out!.startedAt).toBe(HOUR);
    expect(out!.startedAt).toBeGreaterThanOrEqual(ms(9));
    expect(out!.endedAt).toBeLessThanOrEqual(ms(15));
  });

  it('clamps preset endedAt to `now` (no future time)', () => {
    const localNow = ms(11, 15);
    const blocks = [gap(ms(10), ms(13))];
    const out = presetForClick({ ...args(blocks, ms(10, 30)), now: localNow });
    expect(out!.endedAt).toBeLessThanOrEqual(localNow);
  });

  it('returns null when clicking on a tracked WORK block (popover, not composer)', () => {
    const blocks = [work(ms(9), ms(11), 't1')];
    expect(presetForClick(args(blocks, ms(10)))).toBeNull();
  });

  it('returns null when clicking in the future portion of the day', () => {
    const blocks: DayBlockClient[] = [];
    expect(presetForClick({ ...args(blocks, ms(22)), now: ms(20) })).toBeNull();
  });

  it('inherits larkTaskGuid when both gap neighbors agree', () => {
    const blocks = [work(ms(9), ms(10), 'tA'), gap(ms(10), ms(11)), work(ms(11), ms(12), 'tA')];
    expect(presetForClick(args(blocks, ms(10, 30)))!.larkTaskGuid).toBe('tA');
  });

  it('drops the larkTaskGuid when neighbors disagree', () => {
    const blocks = [work(ms(9), ms(10), 'tA'), gap(ms(10), ms(11)), work(ms(11), ms(12), 'tB')];
    expect(presetForClick(args(blocks, ms(10, 30)))!.larkTaskGuid).toBeNull();
  });

  it('uses single-sided neighbor guid when only one side exists', () => {
    const blocks = [work(ms(9), ms(10), 'tA'), gap(ms(10), ms(11))];
    expect(presetForClick(args(blocks, ms(10, 30)))!.larkTaskGuid).toBe('tA');
  });

  it('refuses a sub-5-minute preset (not worth requesting)', () => {
    // Click at 11:58 with now=12:00 leaves only 2 min before the 1h fallback gets clamped.
    const blocks = [gap(ms(10), ms(20))];
    const out = presetForClick({ ...args(blocks, ms(11, 58)), now: ms(12) });
    // The function should either return a valid >=5min window or null.
    if (out) expect(out.endedAt - out.startedAt).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});

describe('isInsidePendingOverlay', () => {
  it('returns true when `ms` is inside any overlay span', () => {
    const overlays = [
      { id: 'r1', startedAt: ms(10), endedAt: ms(11), reason: '', larkTaskGuid: null },
      { id: 'r2', startedAt: ms(14), endedAt: ms(15), reason: '', larkTaskGuid: null },
    ];
    expect(isInsidePendingOverlay(overlays, ms(10, 30))).toBe(true);
    expect(isInsidePendingOverlay(overlays, ms(12))).toBe(false);
    expect(isInsidePendingOverlay(overlays, ms(11))).toBe(false); // half-open right edge
  });
});

describe('windowFor — auto-zoom', () => {
  it('expands a short activity window to the 12h minimum', () => {
    const w = windowFor({ dayStart, dayEnd, firstActivityAt: ms(10), lastActivityAt: ms(11) });
    expect(w.winEnd - w.winStart).toBe(12 * HOUR);
  });

  it('uses real bounds + 15min padding when activity already spans ≥ 12h', () => {
    const w = windowFor({ dayStart, dayEnd, firstActivityAt: ms(7), lastActivityAt: ms(20) });
    expect(w.winStart).toBe(ms(7) - 15 * 60 * 1000);
    expect(w.winEnd).toBe(ms(20) + 15 * 60 * 1000);
  });

  it('defaults to 9am–9pm for an empty day', () => {
    const w = windowFor({ dayStart, dayEnd, firstActivityAt: null, lastActivityAt: null });
    expect(w.winStart).toBe(ms(9));
    expect(w.winEnd).toBe(ms(21));
  });

  it('clamps inside the day even when activity is near a boundary', () => {
    const w = windowFor({ dayStart, dayEnd, firstActivityAt: ms(0, 30), lastActivityAt: ms(1) });
    expect(w.winStart).toBeGreaterThanOrEqual(dayStart);
    expect(w.winEnd).toBeLessThanOrEqual(dayEnd);
    expect(w.winEnd - w.winStart).toBe(12 * HOUR);
  });
});
