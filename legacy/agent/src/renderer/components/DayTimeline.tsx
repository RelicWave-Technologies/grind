import type { TodayEntry, TodaySegment } from '../lib/agent.d';
import { formatWorkspaceTime } from '../lib/workspaceTime';
import { zonedDateTimeParts } from '@grind/types';

interface Props {
  entries: TodayEntry[];
  now: number;
  /** highlight the currently-running entry's open segment */
  runningEntryId?: string | null;
  dayStart: number;
  dayEnd: number;
  timeZone: string;
  markedWindow?: { startedAt: number; endedAt: number; label: string } | null;
}

const TICK_PROBE_MS = 15 * 60_000;
type TimelineKind = TodaySegment['kind'] | 'MANUAL' | 'PENDING';

function timelineLabel(kind: TimelineKind): string {
  if (kind === 'WORK') return 'Tracked';
  if (kind === 'IDLE_TRIMMED') return 'Idle';
  return kind.charAt(0) + kind.slice(1).toLowerCase();
}

function kindClass(kind: TimelineKind): string {
  if (kind === 'WORK') return 'work';
  if (kind === 'IDLE_TRIMMED') return 'idle';
  return kind.toLowerCase();
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Horizontal timeline of today's sessions, matching the dashboard Edit Time
 * ribbon: a stable full-day track with category colors and 3-hour labels.
 */
export default function DayTimeline({ entries, now, runningEntryId, dayStart, dayEnd, timeZone, markedWindow }: Props) {
  const segs = entries.flatMap((entry) => entry.segments.map((segment) => ({
    ...segment,
    entryId: entry.id,
    kind: entry.source === 'MANUAL' ? 'MANUAL' as const : segment.kind,
  })));
  const span = dayEnd - dayStart;

  const ticks = buildTimelineTicks(dayStart, dayEnd, timeZone);

  const pct = (ms: number) => ((ms - dayStart) / span) * 100;
  const nowMs = clamp(now, dayStart, dayEnd);
  const visibleMarkedWindow = markedWindow
    ? clip(markedWindow.startedAt, markedWindow.endedAt, dayStart, dayEnd)
    : null;

  return (
    <div className="dt">
      <div className="dt-track">
        {visibleMarkedWindow && (
          <div
            className="dt-marked-window"
            style={{
              left: `${pct(visibleMarkedWindow.startedAt)}%`,
              width: `${pct(visibleMarkedWindow.endedAt) - pct(visibleMarkedWindow.startedAt)}%`,
            }}
            title={markedWindow?.label}
          />
        )}
        {nowMs < dayEnd && (
          <div className="dt-future" style={{ left: `${pct(nowMs)}%`, width: `${pct(dayEnd) - pct(nowMs)}%` }} />
        )}
        {segs.map((s, i) => {
          const kind = s.kind as TimelineKind;
          const start = clamp(s.startedAt, dayStart, dayEnd);
          const end = clamp(s.endedAt ?? now, dayStart, dayEnd);
          if (end <= start) return null;
          const left = pct(start);
          const width = Math.max(0.6, pct(end) - left);
          const isOpen = s.endedAt === null && s.entryId === runningEntryId;
          return (
            <div
              key={i}
              className={`dt-seg dt-seg-${kindClass(kind)}${isOpen ? ' dt-seg-live' : ''}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${timelineLabel(kind)} · ${formatWorkspaceTime(start, timeZone)} – ${formatWorkspaceTime(end, timeZone)}`}
            />
          );
        })}
        <div className="dt-now" style={{ left: `${pct(nowMs)}%` }} />
      </div>
      <div className="dt-axis">
        {ticks.map((t) => (
          <span key={t} className="dt-tick" style={{ left: `${pct(t)}%` }}>
            {formatWorkspaceTime(t, timeZone)}
          </span>
        ))}
      </div>
    </div>
  );
}

function clip(startedAt: number, endedAt: number, windowStart: number, windowEnd: number) {
  const visibleStart = Math.max(startedAt, windowStart);
  const visibleEnd = Math.min(endedAt, windowEnd);
  return visibleEnd > visibleStart ? { startedAt: visibleStart, endedAt: visibleEnd } : null;
}

export function buildTimelineTicks(dayStart: number, dayEnd: number, timeZone: string): number[] {
  const ticks: number[] = [];
  for (let t = dayStart; t < dayEnd; t += TICK_PROBE_MS) {
    const parts = zonedDateTimeParts(t, timeZone);
    if (parts.minute === 0 && parts.second === 0 && parts.hour % 3 === 0) ticks.push(t);
  }
  return ticks;
}
