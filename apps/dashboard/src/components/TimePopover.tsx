import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { instantForZonedDateTime, zonedDateTimeParts } from '@grind/types';
import { usePopover } from '../lib/popover';

/**
 * Custom time picker. Trigger is an on-brand chip showing "9:25 AM" with a
 * tabular-numerals time + a tiny caret. Click opens a floating popover with
 * two columns (Hour 1–12, Minute in 5-min steps) and an AM/PM toggle.
 *
 * Why custom: native <input type="time"> draws OS chrome that doesn't match
 * the design system (light/premium/violet, rounded numerals), can't be
 * keyboard-styled, and has different behaviors across platforms. This
 * component keeps the chrome on-brand and lets us add nice touches like the
 * "active" border on the currently-selected cell + the AM/PM segmented toggle.
 *
 * The value is an epoch ms. We only touch the time-of-day (hours/minutes);
 * the date is preserved.
 */

interface Props {
  value: number;
  /** Workspace business timezone; wall-clock editing never uses browser time. */
  timeZone: string;
  disabled?: boolean;
  onChange: (epochMs: number) => void;
  /** A11y label, e.g. "Start time". */
  ariaLabel?: string;
  /**
   * Lower bound (inclusive). Times before this are greyed out and not
   * clickable. Used for End time = at least Start + 1min, etc.
   */
  minTime?: number;
  /** Upper bound (inclusive). Times after this are greyed out. */
  maxTime?: number;
}

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; // 12-hour cycle, AM order
// Every minute (0–59) so the picker can land exactly on any real slot edge
// (e.g. 2:41, 4:32). Out-of-range minutes are disabled by `inRange`, so it can
// only ever produce a valid time. The active row auto-scrolls into view.
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

function partsFromMs(ms: number, timeZone: string): { h12: number; m: number; ampm: 'AM' | 'PM' } {
  const local = zonedDateTimeParts(ms, timeZone);
  const rawH = local.hour;
  const ampm = rawH < 12 ? 'AM' : 'PM';
  const h12 = rawH % 12 === 0 ? 12 : rawH % 12;
  return { h12, m: local.minute, ampm };
}

function msFromParts(baseMs: number, h12: number, m: number, ampm: 'AM' | 'PM', timeZone: string): number | null {
  const h24 = ampm === 'AM' ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12);
  const base = zonedDateTimeParts(baseMs, timeZone);
  try {
    return instantForZonedDateTime({
      year: base.year,
      month: base.month,
      day: base.day,
      hour: h24,
      minute: m,
      second: 0,
    }, timeZone).getTime();
  } catch {
    // Spring-forward local times do not exist. Do not silently save a different time.
    return null;
  }
}

function fmt(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(ms));
}

export default function TimePopover({ value, timeZone, disabled, onChange, ariaLabel, minTime, maxTime }: Props) {
  const pop = usePopover({ estimatedHeight: 260 });
  const parts = partsFromMs(value, timeZone);
  const [active, setActive] = useState<{ col: 0 | 1; idx: number }>({ col: 0, idx: HOURS.indexOf(parts.h12) });
  const hourColRef = useRef<HTMLDivElement>(null);
  const minColRef = useRef<HTMLDivElement>(null);

  // A candidate epoch ms is in-range if it falls within [minTime, maxTime].
  // Either bound is optional. Used to grey out invalid cells.
  const inRange = (ms: number | null): boolean => {
    if (ms === null) return false;
    if (minTime !== undefined && ms < minTime) return false;
    if (maxTime !== undefined && ms > maxTime) return false;
    return true;
  };
  const hourEnabled = (h12: number, ampm: 'AM' | 'PM'): boolean =>
    MINUTES.some((m) => inRange(msFromParts(value, h12, m, ampm, timeZone)));
  const minuteEnabled = (m: number, ampm: 'AM' | 'PM'): boolean =>
    HOURS.some((h12) => inRange(msFromParts(value, h12, m, ampm, timeZone)));
  const ampmEnabled = (ampm: 'AM' | 'PM'): boolean =>
    HOURS.some((h12) => MINUTES.some((m) => inRange(msFromParts(value, h12, m, ampm, timeZone))));

  // Re-anchor `active` to the current value whenever the popover opens.
  useEffect(() => {
    if (!pop.open) return;
    setActive({ col: 0, idx: Math.max(0, HOURS.indexOf(parts.h12)) });
    // Scroll the active rows into view.
    requestAnimationFrame(() => {
      hourColRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
      minColRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    });
  }, [pop.open, parts.h12]);

  function pick(h12: number, m: number, ampm: 'AM' | 'PM'): void {
    const candidate = msFromParts(value, h12, m, ampm, timeZone);
    if (candidate !== null && inRange(candidate)) {
      onChange(candidate);
      return;
    }
    // The exact (h, m, ampm) is out of bounds — try to coerce to the nearest
    // valid minute within the same hour first (closest 5-min step), then to
    // any valid minute in that hour. If none, silently no-op (the cell
    // shouldn't have been clickable in the first place, but defence in depth).
    const sortedM = [...MINUTES].sort((a, b) => Math.abs(a - m) - Math.abs(b - m));
    for (const altM of sortedM) {
      const alt = msFromParts(value, h12, altM, ampm, timeZone);
      if (alt !== null && inRange(alt)) {
        onChange(alt);
        return;
      }
    }
  }

  function onKey(e: React.KeyboardEvent): void {
    const cols: Array<{ values: number[]; ref: React.RefObject<HTMLDivElement> }> = [
      { values: HOURS, ref: hourColRef },
      { values: MINUTES, ref: minColRef },
    ];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const col = cols[active.col]!;
      const next = e.key === 'ArrowDown'
        ? Math.min(col.values.length - 1, active.idx + 1)
        : Math.max(0, active.idx - 1);
      setActive({ col: active.col, idx: next });
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const otherCol = (active.col === 0 ? 1 : 0) as 0 | 1;
      const otherVals = cols[otherCol]!.values;
      const cur = otherCol === 0 ? parts.h12 : parts.m;
      const idx = Math.max(0, otherVals.indexOf(cur));
      setActive({ col: otherCol, idx });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const col = cols[active.col]!;
      const v = col.values[active.idx]!;
      if (active.col === 0) pick(v, parts.m, parts.ampm);
      else pick(parts.h12, v, parts.ampm);
      pop.setOpen(false);
    }
  }

  const triggerLabel = useMemo(() => fmt(value, timeZone), [value, timeZone]);

  if (disabled) {
    return <span className="et-chip-trigger et-chip-trigger-time" aria-disabled="true">{triggerLabel}</span>;
  }

  return (
    <>
      <button
        ref={pop.triggerRef as React.RefObject<HTMLButtonElement>}
        type="button"
        className="et-chip-trigger et-chip-trigger-time no-drag"
        aria-haspopup="listbox"
        aria-expanded={pop.open}
        aria-label={ariaLabel ?? 'Time'}
        onClick={(e) => { e.stopPropagation(); pop.setOpen(!pop.open); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            pop.setOpen(true);
          }
        }}
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={11} strokeWidth={2.5} className="et-chip-caret" />
      </button>
      {pop.open && createPortal(
        <div
          ref={pop.popoverRef}
          className="et-pop"
          data-open={pop.open}
          data-flip={pop.flip}
          style={pop.popoverStyle}
          role="dialog"
          onKeyDown={onKey}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="tp-meridiem" role="group" aria-label="AM or PM">
            {(['AM', 'PM'] as const).map((m) => {
              const enabled = ampmEnabled(m);
              return (
                <button
                  key={m}
                  type="button"
                  className="tp-meridiem-btn"
                  aria-pressed={parts.ampm === m}
                  disabled={!enabled}
                  onClick={() => pick(parts.h12, parts.m, m)}
                >
                  {m}
                </button>
              );
            })}
          </div>
          <div className="tp-grid">
            <div className="tp-col" ref={hourColRef} role="listbox" aria-label="Hour">
              {HOURS.map((h, i) => {
                const enabled = hourEnabled(h, parts.ampm);
                return (
                  <button
                    key={h}
                    type="button"
                    className="tp-cell"
                    aria-selected={parts.h12 === h}
                    disabled={!enabled}
                    data-active={active.col === 0 && active.idx === i ? 'true' : undefined}
                    onClick={() => pick(h, parts.m, parts.ampm)}
                  >
                    {h}
                  </button>
                );
              })}
            </div>
            <div className="tp-col" ref={minColRef} role="listbox" aria-label="Minute">
              {MINUTES.map((m, i) => {
                const enabled = minuteEnabled(m, parts.ampm);
                return (
                  <button
                    key={m}
                    type="button"
                    className="tp-cell"
                    aria-selected={parts.m === m}
                    disabled={!enabled}
                    data-active={active.col === 1 && active.idx === i ? 'true' : undefined}
                    onClick={() => pick(parts.h12, m, parts.ampm)}
                  >
                    {String(m).padStart(2, '0')}
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
