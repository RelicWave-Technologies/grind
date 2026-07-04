import type { TodayEntry, TodaySegment } from '../lib/agent.d';

interface Props {
  entries: TodayEntry[];
  now: number;
  /** highlight the currently-running entry's open segment */
  runningEntryId?: string | null;
}

const HOUR = 3_600_000;
type TimelineKind = TodaySegment['kind'] | 'MANUAL' | 'PENDING';

function fmtTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

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

function localDayBounds(now: number): { dayStart: number; dayEnd: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { dayStart: start.getTime(), dayEnd: end.getTime() };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Horizontal timeline of today's sessions, matching the dashboard Edit Time
 * ribbon: a stable full-day track with category colors and 3-hour labels.
 */
export default function DayTimeline({ entries, now, runningEntryId }: Props) {
  const segs = entries.flatMap((e) => e.segments.map((s) => ({ ...s, entryId: e.id })));
  const { dayStart, dayEnd } = localDayBounds(now);
  const span = dayEnd - dayStart;

  const ticks: number[] = [];
  for (let t = dayStart; t < dayEnd; t += 3 * HOUR) ticks.push(t);

  const pct = (ms: number) => ((ms - dayStart) / span) * 100;
  const nowMs = clamp(now, dayStart, dayEnd);

  return (
    <div className="dt">
      <div className="dt-track">
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
              title={`${timelineLabel(kind)} · ${fmtTime(start)} – ${fmtTime(end)}`}
            />
          );
        })}
        <div className="dt-now" style={{ left: `${pct(nowMs)}%` }} />
      </div>
      <div className="dt-axis">
        {ticks.map((t) => (
          <span key={t} className="dt-tick" style={{ left: `${pct(t)}%` }}>
            {fmtTime(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
