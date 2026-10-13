import { useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from './util';
import { IconButton } from './Button';
import { usePopover } from './popover';

/* §5.12c DateRangePicker — the one period picker (Reports, the member drawer,
   Approvals). A mono pill naming the range; it opens two months side by side.
   The first click sets the start, the second the end (either order); a day past
   today, or further than `maxDays` from the start, cannot be picked. Closes on
   pick, outside click or Esc.

   Dates are YYYY-MM-DD calendar keys. They are drawn on a UTC grid, so a key
   reads as the same day in every viewer's timezone. */

export interface DateRangePickerProps {
  from: string;
  to: string;
  /** The workspace's today: nothing after it can be picked. */
  today: string;
  /** The longest range, in days, the caller's endpoint accepts. */
  maxDays: number;
  onChange: (from: string, to: string) => void;
  'aria-label'?: string;
  className?: string;
}

const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function DateRangePicker({
  from,
  to,
  today,
  maxDays,
  onChange,
  'aria-label': ariaLabel = 'Date range',
  className,
}: DateRangePickerProps) {
  const pop = usePopover({ estimatedHeight: 340 });
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState<string | null>(to);
  const [visibleMonth, setVisibleMonth] = useState(() => from.slice(0, 7));
  const months = [visibleMonth, shiftMonth(visibleMonth, 1)] as const;

  function toggle() {
    if (pop.open) return pop.setOpen(false);
    setDraftFrom(from);
    setDraftTo(to);
    setVisibleMonth(from.slice(0, 7));
    pop.setOpen(true);
  }

  function choose(day: string) {
    if (draftTo || Math.abs(daysBetween(draftFrom, day)) > maxDays - 1) {
      setDraftFrom(day);
      setDraftTo(null);
      return;
    }
    const [nextFrom, nextTo] = day < draftFrom ? [day, draftFrom] : [draftFrom, day];
    setDraftFrom(nextFrom);
    setDraftTo(nextTo);
    onChange(nextFrom, nextTo);
    pop.setOpen(false);
  }

  return (
    <>
      <button
        ref={pop.triggerRef as React.RefObject<HTMLButtonElement>}
        type="button"
        className={cx('ui-date-range', pop.open && 'is-open', className)}
        onClick={toggle}
        aria-label={`${ariaLabel}: ${rangeLabel(from, to)}`}
        aria-expanded={pop.open}
        aria-haspopup="dialog"
      >
        <CalendarDays size={15} strokeWidth={1.8} aria-hidden />
        <span>{rangeLabel(from, to)}</span>
      </button>
      {pop.open &&
        createPortal(
          <div
            ref={pop.popoverRef}
            className="ui-popover ui-date-range__pop"
            data-flip={pop.flip}
            style={pop.popoverStyle}
            role="dialog"
            aria-label={ariaLabel}
          >
            <div className="ui-date-range__head">
              <IconButton
                size="sm"
                icon={<ChevronLeft size={15} strokeWidth={1.8} />}
                aria-label="Previous month"
                onClick={() => setVisibleMonth(shiftMonth(visibleMonth, -1))}
              />
              <span className="ui-t-eyebrow">{`${monthLabel(months[0])} / ${monthLabel(months[1])}`}</span>
              <IconButton
                size="sm"
                icon={<ChevronRight size={15} strokeWidth={1.8} />}
                aria-label="Next month"
                onClick={() => setVisibleMonth(shiftMonth(visibleMonth, 1))}
              />
            </div>
            <div className="ui-date-range__months">
              {months.map((month) => (
                <section key={month} className="ui-date-range__month" aria-label={monthLabel(month)}>
                  <div className="ui-date-range__title">{monthLabel(month)}</div>
                  <div className="ui-date-range__weekdays" aria-hidden>
                    {WEEKDAY_INITIALS.map((d, index) => (
                      <span key={`${d}-${index}`}>{d}</span>
                    ))}
                  </div>
                  <div className="ui-date-range__days">
                    {calendarCells(month).map((day, index) => {
                      if (!day) return <span key={`blank-${index}`} aria-hidden />;
                      const inRange = draftTo ? day >= draftFrom && day <= draftTo : day === draftFrom;
                      return (
                        <button
                          key={day}
                          type="button"
                          className={cx(
                            'ui-date-range__day',
                            inRange && 'is-in-range',
                            day === draftFrom && 'is-start',
                            day === draftTo && 'is-end',
                            day === today && 'is-today',
                          )}
                          disabled={day > today || (!draftTo && Math.abs(daysBetween(draftFrom, day)) > maxDays - 1)}
                          onClick={() => choose(day)}
                          aria-label={fullDateLabel(day)}
                          aria-pressed={inRange}
                        >
                          {Number(day.slice(-2))}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// ── Calendar-key helpers (UTC grid; the kit stays free of @grind/types) ─────

function anchor(key: string): Date {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function daysBetween(a: string, b: string): number {
  return Math.round((anchor(b).getTime() - anchor(a).getTime()) / 86_400_000);
}

function shiftMonth(month: string, delta: number): string {
  const d = anchor(`${month}-01`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}

/** The month's days as keys, padded with nulls so the 1st sits under its weekday (Mon first). */
function calendarCells(month: string): Array<string | null> {
  const first = anchor(`${month}-01`);
  const lead = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= count; day += 1) cells.push(`${month}-${String(day).padStart(2, '0')}`);
  return cells;
}

const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });

function rangeLabel(from: string, to: string): string {
  const short = fmt({ month: 'short', day: 'numeric' });
  return `${short.format(anchor(from))} – ${short.format(anchor(to))}`;
}

function monthLabel(month: string): string {
  return fmt({ month: 'long', year: 'numeric' }).format(anchor(`${month}-01`));
}

function fullDateLabel(key: string): string {
  return fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(anchor(key));
}
