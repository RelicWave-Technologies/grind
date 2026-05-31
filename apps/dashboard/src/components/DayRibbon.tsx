import { useRef } from 'react';
import type { DayInsight } from '../lib/types';
import { fmtTime } from '../lib/format';

interface Props {
  day: DayInsight;
  now: number;
  /**
   * Called with the epoch ms at the click location. Only fires for clicks
   * on gap spans (the parent decides what to do). When undefined, the
   * ribbon is non-interactive.
   */
  onClickEpoch?: (epochMs: number) => void;
}

/**
 * Read-only 24h day ribbon. Mirrors the agent's Edit Time ribbon visually —
 * green for tracked WORK / MEETING, amber for APPROVED MANUAL, red-striped
 * for PENDING requests, grey for GAPs, light-grey strikethrough for future.
 *
 * Always renders the full day window so the X-axis is stable across days
 * and across users — a manager scrubbing through team members sees the
 * "8 PM" tick in the same place every time.
 *
 * No interactivity in v1 — clicks/edits land in M11/2b once the manager
 * has had a chance to read what's there.
 */
export function DayRibbon({ day, now, onClickEpoch }: Props) {
  const span = day.dayEnd - day.dayStart;
  const ticks = buildTicks(day.dayStart, day.dayEnd);
  const futureStartsAt = day.isToday ? now : day.isFuture ? day.dayStart : day.dayEnd;
  const trackRef = useRef<HTMLDivElement>(null);

  const pct = (ms: number) => `${((ms - day.dayStart) / span) * 100}%`;

  function handleClick(e: React.MouseEvent) {
    if (!onClickEpoch || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const epoch = day.dayStart + Math.round((x / rect.width) * span);
    onClickEpoch(epoch);
  }

  return (
    <div className="ribbon" aria-hidden>
      <div
        ref={trackRef}
        className={`ribbon-track${onClickEpoch ? ' is-clickable' : ''}`}
        onClick={handleClick}
      >
        {/* Future overlay — light strikethrough for any time still ahead. */}
        {futureStartsAt < day.dayEnd && (
          <div
            className="ribbon-future"
            style={{
              left: pct(futureStartsAt),
              width: `${((day.dayEnd - futureStartsAt) / span) * 100}%`,
            }}
          />
        )}

        {/* Blocks — sorted by startedAt so overlaps don't surprise z-order. */}
        {day.blocks.map((b, i) => (
          <div
            key={`b-${i}-${b.startedAt}`}
            className={`ribbon-block ribbon-block-${b.kind.toLowerCase()}`}
            style={{ left: pct(b.startedAt), width: `${((b.endedAt - b.startedAt) / span) * 100}%` }}
            title={`${b.kind} · ${fmtTime(b.startedAt)} – ${fmtTime(b.endedAt)}`}
          />
        ))}

        {/* Pending requests — striped amber stripe overlay above the track. */}
        {day.pendingOverlay.map((p) => (
          <div
            key={`p-${p.id}`}
            className="ribbon-pending"
            style={{ left: pct(p.startedAt), width: `${((p.endedAt - p.startedAt) / span) * 100}%` }}
            title={`Pending approval — ${p.reason}`}
          />
        ))}

        {/* Now line — only on today. */}
        {day.isToday && (
          <div className="ribbon-now" style={{ left: pct(now) }} aria-hidden />
        )}
      </div>

      {/* Hour ticks */}
      <div className="ribbon-ticks">
        {ticks.map((t) => (
          <div key={t.ms} className="ribbon-tick" style={{ left: pct(t.ms) }}>
            <div className="ribbon-tick-line" />
            <div className="ribbon-tick-label small tertiary">{t.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildTicks(dayStart: number, dayEnd: number): Array<{ ms: number; label: string }> {
  // Every 3 hours: 12 AM · 3 AM · 6 AM · ... · 9 PM = 8 labels on a clean day.
  const out: Array<{ ms: number; label: string }> = [];
  const HOUR = 60 * 60 * 1000;
  const firstTick = Math.ceil(dayStart / HOUR) * HOUR;
  for (let t = firstTick; t < dayEnd; t += HOUR) {
    const d = new Date(t);
    if (d.getHours() % 3 !== 0) continue;
    out.push({ ms: t, label: fmtTime(t) });
  }
  return out;
}
