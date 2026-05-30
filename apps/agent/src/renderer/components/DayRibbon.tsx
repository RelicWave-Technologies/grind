import { useMemo, useRef, useState, type MouseEvent } from 'react';
import type { DayInsight } from '../lib/agent.d';
import {
  presetForClick,
  windowFor,
  snapToGrid,
  isInsidePendingOverlay,
  findBlockAt,
  type DayBlockClient,
} from '../lib/dayRibbon';

const HOUR = 60 * 60 * 1000;

interface Props {
  day: DayInsight;
  now: number;
  /** Lookup task summary for a tooltip — provided by parent. */
  taskNameFor: (guid: string | null | undefined) => string | null;
  /**
   * Called when the user clicks an empty/gap area. The preset is what the
   * composer should use. `null` means the click was on a tracked block or
   * in the future — no composer.
   */
  onPickPreset: (preset: { startedAt: number; endedAt: number; larkTaskGuid: string | null }) => void;
}

/**
 * Wide day-timeline ribbon for the Edit Time tab.
 *
 * Auto-zoomed to the activity window (min 12h). Renders WORK/MEETING/MANUAL
 * /IDLE_TRIMMED blocks coloured by kind (uniform — not by task — to match
 * the Time-Doctor-style scanability). PENDING manual requests are drawn as
 * an amber striped overlay above the track so users see "you already asked
 * for this" instantly.
 *
 * Hover on an empty gap → translucent amber ghost block showing where a
 * click would land. Click → calls `onPickPreset`.
 *
 * a11y note: the ribbon is `aria-hidden`. The DayBlocksTable below is the
 * source of truth for keyboard / screen-reader users.
 */
export default function DayRibbon({ day, now, taskNameFor, onPickPreset }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { winStart, winEnd } = useMemo(
    () => windowFor({ dayStart: day.dayStart, dayEnd: day.dayEnd, firstActivityAt: day.firstActivityAt, lastActivityAt: day.lastActivityAt }),
    [day.dayStart, day.dayEnd, day.firstActivityAt, day.lastActivityAt],
  );
  const span = winEnd - winStart;

  // 2h ticks, with major every 4h. Within the visible window.
  const ticks = useMemo(() => {
    const out: { ms: number; major: boolean }[] = [];
    const firstTick = Math.ceil(winStart / HOUR) * HOUR;
    for (let t = firstTick; t <= winEnd; t += HOUR) {
      const d = new Date(t);
      const h = d.getHours();
      if (h % 2 !== 0) continue;
      out.push({ ms: t, major: h % 4 === 0 });
    }
    return out;
  }, [winStart, winEnd]);

  const pct = (ms: number) => ((ms - winStart) / span) * 100;
  const widthPct = (ms: number) => (ms / span) * 100;

  function clientXToMs(e: MouseEvent<HTMLDivElement>): number | null {
    const el = trackRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    return Math.round(winStart + ratio * span);
  }

  function handleMouseMove(e: MouseEvent<HTMLDivElement>) {
    const t = clientXToMs(e);
    if (t == null) return;
    setHover(snapToGrid(t));
  }
  function handleMouseLeave() {
    setHover(null);
  }
  function handleClick(e: MouseEvent<HTMLDivElement>) {
    const t = clientXToMs(e);
    if (t == null) return;
    const preset = presetForClick({
      blocks: day.blocks as DayBlockClient[],
      clickedAtMs: t,
      dayStart: day.dayStart,
      dayEnd: day.dayEnd,
      now,
    });
    if (preset) onPickPreset(preset);
  }

  // Resolve hover state into a ghost block (suppressed on non-gap hits / future).
  const ghost = useMemo(() => {
    if (hover == null) return null;
    if (hover > now) return null;
    if (isInsidePendingOverlay(day.pendingOverlay, hover)) return null;
    const hit = findBlockAt(day.blocks as DayBlockClient[], hover);
    if (hit && hit.kind !== 'GAP') return null;
    const preset = presetForClick({
      blocks: day.blocks as DayBlockClient[],
      clickedAtMs: hover,
      dayStart: day.dayStart,
      dayEnd: day.dayEnd,
      now,
    });
    if (!preset) return null;
    // Also bail if the preset's RANGE would overlap any pending request —
    // we don't want the ghost ducking under a pending block visually.
    const overlapsPending = day.pendingOverlay.some(
      (p) => p.startedAt < preset.endedAt && p.endedAt > preset.startedAt,
    );
    if (overlapsPending) return null;
    return preset;
  }, [hover, now, day.blocks, day.pendingOverlay, day.dayStart, day.dayEnd]);

  const hoverLabel = hover == null ? null : fmtTime(hover);
  const segCls = (kind: string) =>
    kind === 'WORK' ? 'dr-seg dr-seg-work'
    : kind === 'MEETING' ? 'dr-seg dr-seg-meeting'
    : kind === 'MANUAL' ? 'dr-seg dr-seg-manual'
    : kind === 'IDLE_TRIMMED' ? 'dr-seg dr-seg-idle'
    : 'dr-seg dr-seg-gap';

  return (
    <div className="dr" aria-hidden="true">
      <div
        className="dr-track"
        ref={trackRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        {/* PENDING stripes (above track) */}
        {day.pendingOverlay.map((p) => {
          if (p.endedAt <= winStart || p.startedAt >= winEnd) return null;
          const s = Math.max(p.startedAt, winStart);
          const e = Math.min(p.endedAt, winEnd);
          return (
            <div
              key={p.id}
              className="dr-pending"
              style={{ left: `${pct(s)}%`, width: `${widthPct(e - s)}%` }}
              title={`Pending: ${p.reason}`}
            />
          );
        })}

        {/* Blocks */}
        {day.blocks.map((b, i) => {
          if (b.endedAt <= winStart || b.startedAt >= winEnd) return null;
          const s = Math.max(b.startedAt, winStart);
          const e = Math.min(b.endedAt, winEnd);
          const live = b.isOpen ? ' dr-seg-live' : '';
          const label = b.kind === 'GAP' ? 'Not working' : `${b.kind}${b.larkTaskGuid ? ' · ' + (taskNameFor(b.larkTaskGuid) ?? 'Task') : ''}`;
          return (
            <div
              key={b.timeEntryId ? `${b.timeEntryId}-${i}` : `b-${i}`}
              className={segCls(b.kind) + live}
              style={{ left: `${pct(s)}%`, width: `${widthPct(e - s)}%` }}
              title={`${label} · ${fmtRange(s, e)}`}
            />
          );
        })}

        {/* Future-strikethrough on today */}
        {day.isToday && now < winEnd && now > winStart && (
          <div className="dr-future" style={{ left: `${pct(now)}%`, width: `${widthPct(winEnd - now)}%` }} />
        )}

        {/* "Now" line on today */}
        {day.isToday && now >= winStart && now <= winEnd && (
          <div className="dr-now" style={{ left: `${pct(now)}%` }} />
        )}

        {/* Hover ghost */}
        {ghost && (
          <div
            className="dr-ghost"
            style={{
              left: `${pct(Math.max(ghost.startedAt, winStart))}%`,
              width: `${widthPct(Math.min(ghost.endedAt, winEnd) - Math.max(ghost.startedAt, winStart))}%`,
            }}
          />
        )}
      </div>

      {/* Axis ticks */}
      <div className="dr-axis">
        {ticks.map((t) => (
          <span
            key={t.ms}
            className={'dr-tick' + (t.major ? ' dr-tick-major' : '')}
            style={{ left: `${pct(t.ms)}%` }}
          >
            {hourLabel(t.ms)}
          </span>
        ))}
        {hoverLabel != null && hover != null && (
          <span className="dr-tick dr-tick-major" style={{ left: `${pct(hover)}%`, color: 'var(--c-violet)' }}>
            {hoverLabel}
          </span>
        )}
      </div>
    </div>
  );
}

function hourLabel(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const ampm = h < 12 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${ampm}`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtRange(a: number, b: number): string {
  return `${fmtTime(a)} – ${fmtTime(b)}`;
}
