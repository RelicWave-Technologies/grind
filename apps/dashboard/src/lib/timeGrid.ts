import { possibleInstantsForZonedDateTime, zonedDateTimeParts } from '@grind/types';

/**
 * Pure model behind the TimePopover picker: which (hour, minute, AM/PM) cells
 * are selectable inside an absolute [minTime, maxTime] window, and the exact
 * instant each cell emits when clicked.
 *
 * Four realities this model must handle that a naive "same day as the current
 * value" picker gets wrong:
 *
 *  1. **The window can span a calendar-day boundary.** The last gap of a day
 *     ends at next-day midnight (and night shifts cross it), so the End picker
 *     value sits on the NEXT calendar day while every selectable time lives on
 *     the previous one. Candidates are therefore generated on every calendar
 *     day the window touches, not just the value's day.
 *
 *  2. **Bounds carry seconds; cells are whole minutes.** A gap starting at
 *     12:00:19 must still offer the 12:00 cell — a cell is selectable when its
 *     minute [t, t+60s) OVERLAPS the window, and the emitted instant is clamped
 *     into the window, so a click can never produce an out-of-bounds time.
 *
 *  3. **Enablement must be pair-accurate.** A minute cell's validity depends on
 *     the currently selected hour — advertising a minute that is only valid
 *     under some OTHER hour reads as "the dropdown ignores my click".
 *
 *  4. **A local time can exist zero times or twice.** The skipped hour of a
 *     spring-forward day has no instant at all; the repeated hour of a
 *     fall-back day has two. Candidates come from
 *     `possibleInstantsForZonedDateTime`, so a nonexistent cell is simply
 *     absent (never silently saved as a shifted time) and an ambiguous cell
 *     offers whichever of its two instants actually fits the window.
 */

export type Meridiem = 'AM' | 'PM';

export interface TimeGridInput {
  /** Current picker value (epoch ms). Anchors the preferred calendar day. */
  value: number;
  /** Inclusive lower bound, may carry seconds. Omitted = unbounded. */
  minTime?: number;
  /** Inclusive upper bound, may carry seconds. Omitted = unbounded. */
  maxTime?: number;
  timeZone: string;
}

export interface TimeGrid {
  /** Clamped instant the cell (h12, minute, meridiem) emits, or undefined if not selectable. */
  emitFor(h12: number, minute: number, meridiem: Meridiem): number | undefined;
  /** True when at least one minute is selectable under this hour + meridiem. */
  hourEnabled(h12: number, meridiem: Meridiem): boolean;
  /** True when any cell in this meridiem is selectable. */
  meridiemEnabled(meridiem: Meridiem): boolean;
  /**
   * Best selectable substitute for a cell that is itself disabled: the nearest
   * selectable minute within the same hour first (so a click on an enabled hour
   * keeps that hour), otherwise the selectable cell in the meridiem whose
   * emitted instant is closest to `nearTo`. Undefined when the meridiem has no
   * selectable cell at all.
   */
  nearestValid(h12: number, minute: number, meridiem: Meridiem, nearTo: number): number | undefined;
}

const MINUTE_MS = 60_000;

function cellKey(h12: number, minute: number, meridiem: Meridiem): string {
  return `${meridiem}:${h12}:${minute}`;
}

function toH12(h24: number): { h12: number; meridiem: Meridiem } {
  return { h12: h24 % 12 === 0 ? 12 : h24 % 12, meridiem: h24 < 12 ? 'AM' : 'PM' };
}

interface DayAnchor {
  year: number;
  month: number;
  day: number;
}

/** Distinct zoned calendar days touched by the value and both bounds. */
function anchorDays(input: TimeGridInput): DayAnchor[] {
  const instants = [input.value, input.minTime, input.maxTime]
    .filter((t): t is number => t !== undefined && Number.isFinite(t));
  const seen = new Map<string, DayAnchor>();
  for (const t of instants) {
    const p = zonedDateTimeParts(t, input.timeZone);
    seen.set(`${p.year}-${p.month}-${p.day}`, { year: p.year, month: p.month, day: p.day });
  }
  return [...seen.values()];
}

/**
 * Every instant a wall clock maps to: empty when the local time does not exist
 * (spring-forward gap), two when it repeats (fall-back hour), one normally.
 * Never throws — an unrepresentable time is simply not offered.
 */
function instantsFor(day: DayAnchor, h24: number, minute: number, timeZone: string): number[] {
  try {
    return possibleInstantsForZonedDateTime({ ...day, hour: h24, minute, second: 0 }, timeZone)
      .map((d) => d.getTime())
      .filter((t) => Number.isFinite(t));
  } catch {
    return [];
  }
}

/**
 * Build the selectable-cell model for one picker instance. Cost is bounded: an
 * hour whose first and last minutes are each unambiguous and sit exactly 59
 * minutes apart is filled linearly (two conversions); only irregular hours —
 * DST transitions — pay a per-minute conversion.
 */
export function buildTimeGrid(input: TimeGridInput): TimeGrid {
  const lo = input.minTime ?? Number.NEGATIVE_INFINITY;
  const hi = input.maxTime ?? Number.POSITIVE_INFINITY;

  // Cell key -> emitted instant. Among duplicate candidates across anchor days,
  // the one closest to the current value wins, so the picker prefers the date
  // the user is already looking at when both days accept the same wall time.
  const cells = new Map<string, number>();
  const meridiems = { AM: false, PM: false };

  if (lo <= hi) {
    for (const day of anchorDays(input)) {
      for (let h24 = 0; h24 < 24; h24 += 1) {
        const firsts = instantsFor(day, h24, 0, input.timeZone);
        const lasts = instantsFor(day, h24, 59, input.timeZone);
        const first = firsts.length === 1 ? firsts[0]! : null;
        const last = lasts.length === 1 ? lasts[0]! : null;
        const linear = first !== null && last !== null && last - first === 59 * MINUTE_MS;

        // Whole hour outside the window → skip without touching its minutes.
        if (linear && (first > hi || last + MINUTE_MS <= lo)) continue;

        const { h12, meridiem } = toH12(h24);
        for (let minute = 0; minute < 60; minute += 1) {
          const candidates = linear
            ? [first + minute * MINUTE_MS]
            : instantsFor(day, h24, minute, input.timeZone);
          for (const t of candidates) {
            // Selectable when the cell's minute [t, t+60s) overlaps [lo, hi].
            if (t > hi || t + MINUTE_MS <= lo) continue;
            const emit = Math.min(Math.max(t, lo), hi);
            const key = cellKey(h12, minute, meridiem);
            const existing = cells.get(key);
            if (existing === undefined || Math.abs(emit - input.value) < Math.abs(existing - input.value)) {
              cells.set(key, emit);
            }
            meridiems[meridiem] = true;
          }
        }
      }
    }
  }

  function emitFor(h12: number, minute: number, meridiem: Meridiem): number | undefined {
    return cells.get(cellKey(h12, minute, meridiem));
  }

  function hourEnabled(h12: number, meridiem: Meridiem): boolean {
    for (let minute = 0; minute < 60; minute += 1) {
      if (cells.has(cellKey(h12, minute, meridiem))) return true;
    }
    return false;
  }

  function nearestValid(h12: number, minute: number, meridiem: Meridiem, nearTo: number): number | undefined {
    // Same hour, nearest minute — a click on an enabled hour keeps that hour.
    let best: number | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let m = 0; m < 60; m += 1) {
      const emit = cells.get(cellKey(h12, m, meridiem));
      if (emit === undefined) continue;
      const dist = Math.abs(m - minute);
      if (dist < bestDist) {
        best = emit;
        bestDist = dist;
      }
    }
    if (best !== undefined) return best;
    // Hour has nothing selectable (e.g. an AM/PM toggle from a far-away time) —
    // fall back to the closest selectable instant anywhere in the meridiem.
    for (const [key, emit] of cells) {
      if (!key.startsWith(`${meridiem}:`)) continue;
      const dist = Math.abs(emit - nearTo);
      if (dist < bestDist) {
        best = emit;
        bestDist = dist;
      }
    }
    return best;
  }

  return {
    emitFor,
    hourEnabled,
    meridiemEnabled: (meridiem) => meridiems[meridiem],
    nearestValid,
  };
}
