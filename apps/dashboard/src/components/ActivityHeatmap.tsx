import type { ActivityHeatmap, DayInsight } from '../lib/types';
import { fmtTime } from '../lib/format';

interface Props {
  day: DayInsight;
  heatmap: ActivityHeatmap;
  /** Bounds represented by `heatmap`; defaults to the editable review window. */
  window?: { startedAt: number; endedAt: number };
}

/**
 * Per-minute (default 10-min bucket) productivity heatmap. One cell per
 * bucket spanning the day. Colour encodes productivity score 0-100:
 *   null  → grey (no samples — the agent wasn't running)
 *   0     → light grey (samples landed but the user was idle)
 *   1-100 → green scale, darker as more productive
 *
 * a11y note: heatmap is `aria-hidden`. Numeric totals on the entries table
 * convey the same information to screen readers.
 */
export function ActivityHeatmap({ day, heatmap, window }: Props) {
  const cellCount = heatmap.buckets.length;
  if (cellCount === 0) return null;
  const bucketMs = heatmap.bucketMs;
  const windowStart = window?.startedAt ?? day.dayStart;
  const windowEnd = window?.endedAt ?? day.dayEnd;

  return (
    <div className="heatmap" aria-hidden>
      <div className="heatmap-row" style={{ gridTemplateColumns: `repeat(${cellCount}, minmax(2px, 1fr))` }}>
        {heatmap.buckets.map((v, i) => {
          const start = windowStart + i * bucketMs;
          const end = Math.min(windowStart + (i + 1) * bucketMs, windowEnd);
          if (start >= windowEnd) return null;
          const title =
            v === null
              ? `${fmtTime(start, day.timezone)} – ${fmtTime(end, day.timezone)} · no activity data`
              : `${fmtTime(start, day.timezone)} – ${fmtTime(end, day.timezone)} · ${v}% productive · ${heatmap.sampleCounts[i] ?? 0} sample${(heatmap.sampleCounts[i] ?? 0) === 1 ? '' : 's'}`;
          return (
            <div
              key={i}
              className={`hm-cell${v === null ? ' is-empty' : v === 0 ? ' is-idle' : ''}`}
              style={v && v > 0 ? cellStyle(v) : undefined}
              title={title}
            />
          );
        })}
      </div>
      <div className="heatmap-foot small tertiary">
        Each cell = {Math.round(bucketMs / 60_000)} min · darker = more productive
      </div>
    </div>
  );
}

/** Pure-CSS heat ramp: 1 → faint green, 100 → saturated green. */
function cellStyle(v: number): React.CSSProperties {
  // Map 1..100 → 0.15..0.85 for fill opacity. We can't use a hue-rotate
  // because the tokens are already brand-locked to var(--c-green).
  const opacity = 0.15 + (Math.min(100, Math.max(1, v)) / 100) * 0.7;
  return {
    background: `rgba(33, 193, 122, ${opacity})`,
    borderColor: `rgba(33, 193, 122, ${Math.min(1, opacity + 0.1)})`,
  };
}
