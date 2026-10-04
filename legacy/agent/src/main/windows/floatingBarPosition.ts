/**
 * Pure geometry for the floating bar's on-screen position (no Electron import,
 * so it's unit-testable). Two concerns:
 *
 *   1. Where does the bar live by default? → bottom-right of the primary work
 *      area, with a margin.
 *   2. Is a *saved* position still valid? → only if a meaningful chunk of the
 *      bar overlaps some visible display's work area. A monitor unplugged
 *      since last launch must not strand the bar off-screen.
 *
 * `resolvePosition` is the single entry point the window layer calls: given the
 * saved coords (or null) and the current display work areas, it returns the
 * coordinates to actually use — saved-and-clamped when valid, default corner
 * otherwise.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Gap between the bar and the screen edge for the default corner. */
export const EDGE_MARGIN = 20;

/**
 * Minimum on-screen overlap (px, per axis) for a saved position to count as
 * "still visible". A few px peeking out is not enough — the user must be able
 * to grab the bar.
 */
const MIN_VISIBLE = 48;

/** Bottom-right of the primary work area, inset by EDGE_MARGIN. */
export function defaultCorner(primaryWorkArea: Rect, size: Size): Point {
  return {
    x: primaryWorkArea.x + primaryWorkArea.width - size.width - EDGE_MARGIN,
    y: primaryWorkArea.y + primaryWorkArea.height - size.height - EDGE_MARGIN,
  };
}

/** Overlap length of two 1-D segments [aStart, aEnd) and [bStart, bEnd). */
function overlap1d(aStart: number, aLen: number, bStart: number, bLen: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aStart + aLen, bStart + bLen);
  return Math.max(0, end - start);
}

/**
 * True if a window of `size` placed at `pos` shows at least MIN_VISIBLE px on
 * BOTH axes within at least one of the given work areas.
 */
export function isVisibleEnough(pos: Point, size: Size, workAreas: Rect[]): boolean {
  for (const wa of workAreas) {
    const ox = overlap1d(pos.x, size.width, wa.x, wa.width);
    const oy = overlap1d(pos.y, size.height, wa.y, wa.height);
    const needX = Math.min(MIN_VISIBLE, size.width);
    const needY = Math.min(MIN_VISIBLE, size.height);
    if (ox >= needX && oy >= needY) return true;
  }
  return false;
}

/**
 * Decide the floating bar's position.
 *
 * - `saved` valid + still visible  → use it verbatim (user owns it).
 * - `saved` present but off-screen → default corner (monitor changed).
 * - `saved` null                   → default corner (first run / after reset).
 */
export function resolvePosition(
  saved: Point | null,
  size: Size,
  primaryWorkArea: Rect,
  workAreas: Rect[],
): Point {
  if (saved && isVisibleEnough(saved, size, workAreas)) return saved;
  return defaultCorner(primaryWorkArea, size);
}
