import { useMemo, useRef, useState, type MouseEvent } from 'react';
import type { DayInsight, DayBlock } from '../lib/types';
import { fmtTime } from '../lib/format';

interface Props {
  day: DayInsight;
  now: number;
  /** Show the "click to add" gap ghost. False for read-only (teammate) views. */
  editable?: boolean;
  /**
   * Called with the epoch ms at the click location (any slot). The parent
   * scrolls/focuses the matching row, and for an editable gap seeds the
   * composer. When undefined, the ribbon is non-interactive.
   */
  onClickEpoch?: (epochMs: number) => void;
  /**
   * Bar↔row link. Called with the row key of the block under the cursor
   * (`entry-<id>`, `pending-<id>`, `gap-<startMs>`) or `null` to clear.
   */
  onHoverRowId?: (rowId: string | null) => void;
}

const FIVE_MIN_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function snapToGrid(ms: number, stepMs = FIVE_MIN_MS): number {
  return Math.round(ms / stepMs) * stepMs;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function findBlockAt(blocks: DayBlock[], t: number): DayBlock | null {
  for (const b of blocks) if (b.startedAt <= t && t < b.endedAt) return b;
  return null;
}

/**
 * Compute the preview range a click at `t` would create. Mirrors the agent's
 * presetForClick rules:
 *   - Click in a real GAP → snap to the whole gap (capped at `now`).
 *   - Click outside any block (pre-/post-activity) → synthesize a virtual
 *     gap bounded by the nearest non-gap blocks.
 *   - Click in WORK/MEETING/MANUAL/IDLE_TRIMMED → return null (no ghost).
 */
function previewForHover(args: {
  blocks: DayBlock[];
  t: number;
  dayStart: number;
  dayEnd: number;
  now: number;
}): { startedAt: number; endedAt: number } | null {
  const { blocks, t, dayStart, dayEnd, now } = args;
  if (t < dayStart || t >= dayEnd || t > now) return null;
  const hit = findBlockAt(blocks, t);
  if (hit && hit.kind !== 'GAP') return null;
  if (hit && hit.kind === 'GAP') {
    return {
      startedAt: snapToGrid(hit.startedAt),
      endedAt: snapToGrid(Math.min(hit.endedAt, now)),
    };
  }
  // Virtual gap: bounded by neighbors.
  const occupied = blocks.filter((b) => b.kind !== 'GAP').sort((a, b) => a.startedAt - b.startedAt);
  let left = dayStart;
  let right = Math.min(dayEnd, now);
  for (const r of occupied) {
    if (r.endedAt <= t) left = Math.max(left, r.endedAt);
    if (r.startedAt > t) {
      right = Math.min(right, r.startedAt);
      break;
    }
  }
  if (right <= left) return null;
  return { startedAt: snapToGrid(left), endedAt: snapToGrid(right) };
}

/**
 * Read-only 24h day ribbon with hover affordances:
 *   - Hovering over the track shows a ghost block where a click would land
 *     (gap preview, in violet) + a tooltip label with the snapped time.
 *   - Hovering over a tracked/meeting/manual/pending block calls
 *     `onHoverRowId` so the parent can highlight the matching table row.
 *   - Clicking on a gap (or pre-/post-activity dead space) fires
 *     `onClickEpoch` so the parent's gap composer can preset.
 *
 * Always renders the full 24h window for axis stability across days.
 */
export function DayRibbon({ day, now, editable = false, onClickEpoch, onHoverRowId }: Props) {
  const span = day.dayEnd - day.dayStart;
  const ticks = buildTicks(day.dayStart, day.dayEnd);
  const futureStartsAt = day.isToday ? now : day.isFuture ? day.dayStart : day.dayEnd;
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  const pct = (ms: number) => `${((ms - day.dayStart) / span) * 100}%`;
  const interactive = !!onClickEpoch;

  function epochFromEvent(e: MouseEvent): number | null {
    if (!trackRef.current) return null;
    const rect = trackRef.current.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    return Math.round(day.dayStart + (x / rect.width) * span);
  }

  function handleMove(e: MouseEvent) {
    const t = epochFromEvent(e);
    if (t == null) return;
    setHoverMs(snapToGrid(t));
  }
  function handleLeave() {
    setHoverMs(null);
    onHoverRowId?.(null);
  }
  function handleClick(e: MouseEvent) {
    if (!onClickEpoch) return;
    const t = epochFromEvent(e);
    if (t == null) return;
    onClickEpoch(t);
  }

  // Ghost preview suppressed unless we're hovering a GAP (or pre-/post-
  // activity space) and the parent gave us an onClickEpoch (= editable).
  const ghost = useMemo(() => {
    if (!editable || hoverMs == null) return null;
    // previewForHover already returns null over any non-GAP block (incl. the
    // PENDING blocks now in the partition), so pending is auto-excluded.
    return previewForHover({
      blocks: day.blocks,
      t: hoverMs,
      dayStart: day.dayStart,
      dayEnd: day.dayEnd,
      now,
    });
  }, [editable, hoverMs, day.blocks, day.dayStart, day.dayEnd, now]);

  return (
    <div className="ribbon" aria-hidden>
      <div
        ref={trackRef}
        className={`ribbon-track${interactive ? ' is-clickable' : ''}`}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onClick={handleClick}
      >
        {futureStartsAt < day.dayEnd && (
          <div
            className="ribbon-future"
            style={{ left: pct(futureStartsAt), width: `${((day.dayEnd - futureStartsAt) / span) * 100}%` }}
          />
        )}

        {day.blocks.map((b, i) => {
          if (b.kind === 'GAP') return null; // gap is the absence of a block
          const att = b.attendeeIds?.length ?? 0;
          const attSuffix = att > 0 ? ` · ${att} attendee${att === 1 ? '' : 's'}` : '';
          const width = `${((b.endedAt - b.startedAt) / span) * 100}%`;
          if (b.kind === 'PENDING') {
            return (
              <div
                key={`b-${i}-${b.startedAt}`}
                className="ribbon-pending"
                style={{ left: pct(b.startedAt), width }}
                title={`Pending approval — ${b.reason ?? ''}${attSuffix}`}
                onMouseEnter={() => onHoverRowId?.(`pending-${b.requestId}`)}
                onMouseLeave={() => onHoverRowId?.(null)}
              />
            );
          }
          const rowId = `entry-${b.timeEntryId ?? b.startedAt}`;
          return (
            <div
              key={`b-${i}-${b.startedAt}`}
              className={`ribbon-block ribbon-block-${b.kind.toLowerCase()}`}
              style={{ left: pct(b.startedAt), width }}
              title={`${b.kind} · ${fmtTime(b.startedAt)} – ${fmtTime(b.endedAt)}${attSuffix}`}
              onMouseEnter={() => onHoverRowId?.(rowId)}
              onMouseLeave={() => onHoverRowId?.(null)}
            />
          );
        })}

        {ghost && (
          <div
            className="ribbon-ghost"
            style={{
              left: pct(ghost.startedAt),
              width: `${((ghost.endedAt - ghost.startedAt) / span) * 100}%`,
            }}
            title={`Click to add manual time · ${fmtTime(ghost.startedAt)} – ${fmtTime(ghost.endedAt)}`}
          />
        )}

        {day.isToday && <div className="ribbon-now" style={{ left: pct(now) }} aria-hidden />}

        {hoverMs != null && (
          <div className="ribbon-hover-line" style={{ left: pct(hoverMs) }} aria-hidden />
        )}
      </div>

      <div className="ribbon-ticks">
        {ticks.map((t) => (
          <div key={t.ms} className="ribbon-tick" style={{ left: pct(t.ms) }}>
            <div className="ribbon-tick-line" />
            <div className="ribbon-tick-label small tertiary">{fmtTime(t.ms)}</div>
          </div>
        ))}
        {hoverMs != null && (
          <div
            className="ribbon-tick ribbon-tick-hover"
            style={{ left: pct(hoverMs) }}
            aria-hidden
          >
            <div className="ribbon-tick-line ribbon-tick-line-hover" />
            <div className="ribbon-tick-label ribbon-tick-label-hover">{fmtTime(hoverMs)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function buildTicks(dayStart: number, dayEnd: number): Array<{ ms: number }> {
  const out: Array<{ ms: number }> = [];
  const first = Math.ceil(dayStart / HOUR_MS) * HOUR_MS;
  for (let t = first; t < dayEnd; t += HOUR_MS) {
    if (new Date(t).getHours() % 3 !== 0) continue;
    out.push({ ms: t });
  }
  return out;
}
