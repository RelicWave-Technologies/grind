import type { TodayEntry } from '../lib/agent.d';
import { projectStyle } from '../lib/projectStyle';

interface Props {
  entries: TodayEntry[];
  now: number;
  /** highlight the currently-running entry's open segment */
  runningEntryId?: string | null;
}

const HOUR = 3_600_000;

function hourLabel(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const ampm = h < 12 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${ampm}`;
}

/**
 * Horizontal timeline of today's tracked sessions, positioned by real
 * time-of-day. Work segments use the project color, meetings blue, trimmed
 * idle gray. The open segment extends to `now` and pulses.
 */
export default function DayTimeline({ entries, now, runningEntryId }: Props) {
  const segs = entries.flatMap((e) =>
    // Color key: prefer the Lark task, then project, then a stable default —
    // each tracked thing gets its own deterministic color on the ribbon.
    e.segments.map((s) => ({ ...s, colorKey: e.larkTaskGuid ?? 'work', entryId: e.id })),
  );

  const startsToday = segs.map((s) => s.startedAt);
  const earliest = startsToday.length ? Math.min(...startsToday) : now - 2 * HOUR;

  // Window: floor(earliest) .. ceil(now), at least a 4h span.
  const winStart = Math.floor(earliest / HOUR) * HOUR;
  let winEnd = Math.ceil(now / HOUR) * HOUR;
  if (winEnd - winStart < 4 * HOUR) winEnd = winStart + 4 * HOUR;
  const span = winEnd - winStart;

  const ticks: number[] = [];
  const stepHours = span > 8 * HOUR ? 2 : 1;
  for (let t = winStart; t <= winEnd; t += stepHours * HOUR) ticks.push(t);

  const pct = (ms: number) => ((ms - winStart) / span) * 100;

  return (
    <div className="dt">
      <div className="dt-track">
        {segs.map((s, i) => {
          const end = s.endedAt ?? now;
          const left = pct(s.startedAt);
          const width = Math.max(0.6, pct(end) - left);
          const isOpen = s.endedAt === null && s.entryId === runningEntryId;
          let bg = 'var(--separator-strong)';
          if (s.kind === 'WORK') bg = projectStyle(s.colorKey).color;
          else if (s.kind === 'MEETING') bg = 'var(--c-blue-bg)';
          else bg = 'rgba(0,0,0,0.08)';
          return (
            <div
              key={i}
              className={`dt-seg${isOpen ? ' dt-seg-live' : ''}`}
              style={{ left: `${left}%`, width: `${width}%`, background: bg }}
              title={s.kind.toLowerCase()}
            />
          );
        })}
        {/* now marker */}
        <div className="dt-now" style={{ left: `${pct(now)}%` }} />
      </div>
      <div className="dt-axis">
        {ticks.map((t) => (
          <span key={t} className="dt-tick" style={{ left: `${pct(t)}%` }}>
            {hourLabel(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
