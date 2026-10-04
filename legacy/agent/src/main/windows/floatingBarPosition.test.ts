import { describe, it, expect } from 'vitest';
import {
  defaultCorner,
  isVisibleEnough,
  resolvePosition,
  EDGE_MARGIN,
  type Rect,
} from './floatingBarPosition';

const SIZE = { width: 248, height: 56 };
// A single 1440x900 primary display whose work area starts at (0,0).
const PRIMARY: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const ONE_SCREEN = [PRIMARY];

describe('defaultCorner', () => {
  it('pins to the bottom-right of the work area with the edge margin', () => {
    const p = defaultCorner(PRIMARY, SIZE);
    expect(p.x).toBe(1440 - 248 - EDGE_MARGIN);
    expect(p.y).toBe(900 - 56 - EDGE_MARGIN);
  });

  it('respects a non-zero work-area origin (e.g. macOS menu bar / dock inset)', () => {
    const inset: Rect = { x: 0, y: 25, width: 1440, height: 850 };
    const p = defaultCorner(inset, SIZE);
    expect(p.y).toBe(25 + 850 - 56 - EDGE_MARGIN);
  });
});

describe('isVisibleEnough', () => {
  it('true when the bar sits fully inside the work area', () => {
    expect(isVisibleEnough({ x: 100, y: 100 }, SIZE, ONE_SCREEN)).toBe(true);
  });

  it('false when the bar is entirely off-screen (monitor unplugged)', () => {
    // Saved on a second monitor at x=2000 that no longer exists.
    expect(isVisibleEnough({ x: 2000, y: 300 }, SIZE, ONE_SCREEN)).toBe(false);
  });

  it('false when only a sliver peeks in (< MIN_VISIBLE)', () => {
    // Only 10px of the bar's left edge is on-screen.
    expect(isVisibleEnough({ x: 1440 - 10, y: 400 }, SIZE, ONE_SCREEN)).toBe(false);
  });

  it('true when grabbable amount is on-screen at the right edge', () => {
    // 100px of the bar still on-screen — grabbable.
    expect(isVisibleEnough({ x: 1440 - 100, y: 400 }, SIZE, ONE_SCREEN)).toBe(true);
  });

  it('true when visible on a secondary display', () => {
    const second: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };
    expect(isVisibleEnough({ x: 1600, y: 200 }, SIZE, [PRIMARY, second])).toBe(true);
  });

  it('false above the top edge by more than the bar height', () => {
    expect(isVisibleEnough({ x: 100, y: -100 }, SIZE, ONE_SCREEN)).toBe(false);
  });
});

describe('resolvePosition', () => {
  it('returns the saved position verbatim when still visible', () => {
    const saved = { x: 300, y: 250 };
    expect(resolvePosition(saved, SIZE, PRIMARY, ONE_SCREEN)).toEqual(saved);
  });

  it('falls back to the default corner when saved is off-screen', () => {
    const offscreen = { x: 5000, y: 5000 };
    expect(resolvePosition(offscreen, SIZE, PRIMARY, ONE_SCREEN)).toEqual(defaultCorner(PRIMARY, SIZE));
  });

  it('falls back to the default corner when nothing is saved', () => {
    expect(resolvePosition(null, SIZE, PRIMARY, ONE_SCREEN)).toEqual(defaultCorner(PRIMARY, SIZE));
  });

  it('keeps a position the user dragged to a second monitor', () => {
    const second: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };
    const saved = { x: 2000, y: 500 };
    expect(resolvePosition(saved, SIZE, PRIMARY, [PRIMARY, second])).toEqual(saved);
  });
});
