import { describe, expect, it } from 'vitest';
import { buildTimeGrid } from './timeGrid';

// Fixed-offset zone (+05:30, no DST) keeps every expectation deterministic.
const TZ = 'Asia/Kolkata';
const T = (iso: string): number => Date.parse(iso);

describe('buildTimeGrid', () => {
  it('offers previous-day evening cells when the window ends at next-day midnight', () => {
    // The "last gap of the day" shape that bricked the picker: the End value
    // sits at next-day 00:00, every selectable time lives on the previous day.
    const midnight = T('2026-07-24T00:00:00+05:30');
    const grid = buildTimeGrid({
      value: midnight,
      minTime: T('2026-07-23T23:31:00+05:30'),
      maxTime: midnight,
      timeZone: TZ,
    });

    expect(grid.emitFor(11, 45, 'PM')).toBe(T('2026-07-23T23:45:00+05:30'));
    expect(grid.emitFor(12, 0, 'AM')).toBe(midnight); // exact upper edge
    expect(grid.emitFor(1, 0, 'AM')).toBeUndefined(); // next-day 1 AM is past the window
    expect(grid.emitFor(11, 30, 'PM')).toBeUndefined(); // before the lower bound
    expect(grid.hourEnabled(11, 'PM')).toBe(true);
    expect(grid.meridiemEnabled('PM')).toBe(true);
    expect(grid.meridiemEnabled('AM')).toBe(true);
  });

  it('keeps a boundary minute selectable when the bound carries seconds, clamping the emit', () => {
    // Gap starting at 12:00:19 PM must still offer the 12:00 cell — and
    // selecting it must emit exactly the bound, never an instant outside it.
    const lower = T('2026-07-23T12:00:19+05:30');
    const grid = buildTimeGrid({
      value: T('2026-07-23T12:30:00+05:30'),
      minTime: lower,
      maxTime: T('2026-07-23T17:07:45+05:30'),
      timeZone: TZ,
    });

    expect(grid.emitFor(12, 0, 'PM')).toBe(lower); // clamped up to 12:00:19
    expect(grid.emitFor(5, 7, 'PM')).toBe(T('2026-07-23T17:07:00+05:30')); // inside, unclamped
    expect(grid.emitFor(5, 8, 'PM')).toBeUndefined(); // past the upper bound
    expect(grid.emitFor(11, 59, 'AM')).toBeUndefined(); // wholly before the lower bound
  });

  it('enables every cell with exact wall-clock instants when unbounded', () => {
    const grid = buildTimeGrid({ value: T('2026-07-23T09:25:00+05:30'), timeZone: TZ });

    expect(grid.emitFor(9, 25, 'AM')).toBe(T('2026-07-23T09:25:00+05:30'));
    expect(grid.emitFor(12, 0, 'AM')).toBe(T('2026-07-23T00:00:00+05:30'));
    expect(grid.emitFor(11, 59, 'PM')).toBe(T('2026-07-23T23:59:00+05:30'));
    expect(grid.meridiemEnabled('AM')).toBe(true);
    expect(grid.meridiemEnabled('PM')).toBe(true);
  });

  it('disables everything on an inverted window instead of guessing', () => {
    const grid = buildTimeGrid({
      value: T('2026-07-23T10:00:00+05:30'),
      minTime: T('2026-07-23T11:00:00+05:30'),
      maxTime: T('2026-07-23T10:00:00+05:30'),
      timeZone: TZ,
    });

    expect(grid.meridiemEnabled('AM')).toBe(false);
    expect(grid.meridiemEnabled('PM')).toBe(false);
    expect(grid.emitFor(10, 30, 'AM')).toBeUndefined();
    expect(grid.nearestValid(10, 30, 'AM', T('2026-07-23T10:00:00+05:30'))).toBeUndefined();
  });

  it('is pair-accurate: a minute is only offered under an hour it is valid for', () => {
    const grid = buildTimeGrid({
      value: T('2026-07-23T09:15:00+05:30'),
      minTime: T('2026-07-23T09:10:00+05:30'),
      maxTime: T('2026-07-23T09:20:00+05:30'),
      timeZone: TZ,
    });

    expect(grid.hourEnabled(9, 'AM')).toBe(true);
    expect(grid.hourEnabled(10, 'AM')).toBe(false);
    expect(grid.emitFor(9, 15, 'AM')).toBe(T('2026-07-23T09:15:00+05:30'));
    expect(grid.emitFor(9, 30, 'AM')).toBeUndefined(); // valid hour, invalid pair
  });

  it('coerces a disabled cell to the nearest valid minute in the same hour first', () => {
    const grid = buildTimeGrid({
      value: T('2026-07-23T09:15:00+05:30'),
      minTime: T('2026-07-23T09:10:00+05:30'),
      maxTime: T('2026-07-23T09:20:00+05:30'),
      timeZone: TZ,
    });

    expect(grid.nearestValid(9, 30, 'AM', T('2026-07-23T09:15:00+05:30')))
      .toBe(T('2026-07-23T09:20:00+05:30'));
  });

  it('falls back to the closest instant in the meridiem when the hour has no valid minute', () => {
    // AM/PM toggle from a far-away time: hour 12 PM (noon) is outside the
    // evening-only window, so the pick lands on the nearest selectable time.
    const midnight = T('2026-07-24T00:00:00+05:30');
    const grid = buildTimeGrid({
      value: midnight,
      minTime: T('2026-07-23T23:31:00+05:30'),
      maxTime: midnight,
      timeZone: TZ,
    });

    expect(grid.nearestValid(12, 0, 'PM', midnight)).toBe(T('2026-07-23T23:59:00+05:30'));
  });

  it('serves both sides of midnight for a window spanning two calendar days', () => {
    // Night-shift shape: 22:00 → 02:00. Late-evening PM cells emit on day one,
    // early-morning AM cells on day two.
    const grid = buildTimeGrid({
      value: T('2026-07-24T00:30:00+05:30'),
      minTime: T('2026-07-23T22:00:00+05:30'),
      maxTime: T('2026-07-24T02:00:00+05:30'),
      timeZone: TZ,
    });

    expect(grid.emitFor(11, 0, 'PM')).toBe(T('2026-07-23T23:00:00+05:30'));
    expect(grid.emitFor(1, 0, 'AM')).toBe(T('2026-07-24T01:00:00+05:30'));
    expect(grid.emitFor(2, 0, 'AM')).toBe(T('2026-07-24T02:00:00+05:30')); // inclusive edge
    expect(grid.emitFor(2, 1, 'AM')).toBeUndefined();
    expect(grid.emitFor(9, 0, 'PM')).toBeUndefined(); // 21:00 day one — before the window
  });

  it('builds an exact grid across a DST transition day without drifting', () => {
    // America/New_York springs forward 2026-03-08 02:00 → 03:00. The 1 AM and
    // 3 AM cells must emit their true instants (1 AM EST, 3 AM EDT).
    const grid = buildTimeGrid({
      value: T('2026-03-08T12:00:00-04:00'),
      minTime: T('2026-03-08T00:00:00-05:00'),
      maxTime: T('2026-03-08T23:59:00-04:00'),
      timeZone: 'America/New_York',
    });

    expect(grid.emitFor(1, 30, 'AM')).toBe(T('2026-03-08T01:30:00-05:00'));
    expect(grid.emitFor(3, 30, 'AM')).toBe(T('2026-03-08T03:30:00-04:00'));
    expect(grid.emitFor(11, 0, 'PM')).toBe(T('2026-03-08T23:00:00-04:00'));
  });

  it('never offers a local time that does not exist (spring-forward gap)', () => {
    // America/New_York 2026-03-08: 02:00 → 03:00 never happens. Those cells
    // must be absent, not silently resolve to a shifted instant.
    const grid = buildTimeGrid({
      value: T('2026-03-08T12:00:00-04:00'),
      timeZone: 'America/New_York',
    });

    expect(grid.emitFor(2, 30, 'AM')).toBeUndefined();
    expect(grid.hourEnabled(2, 'AM')).toBe(false);
    expect(grid.emitFor(1, 30, 'AM')).toBe(T('2026-03-08T01:30:00-05:00'));
    expect(grid.emitFor(3, 30, 'AM')).toBe(T('2026-03-08T03:30:00-04:00'));
  });

  it('offers the repeated fall-back hour exactly once, resolving to a real instant', () => {
    // America/New_York 2026-11-01: 01:00–01:59 occurs twice. The cell must
    // exist and emit an instant that reads back as 1:xx AM.
    const grid = buildTimeGrid({
      value: T('2026-11-01T12:00:00-05:00'),
      timeZone: 'America/New_York',
    });

    const emit = grid.emitFor(1, 30, 'AM');
    expect(emit).toBeDefined();
    expect(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(emit)).toBe('1:30 AM');
  });
});
