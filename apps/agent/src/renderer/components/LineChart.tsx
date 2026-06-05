interface Props {
  points: number[]; // y-values, 0..max
  labels: string[];
  height?: number;
}

/** Smooth gradient area line chart (sample/static for now). */
export default function LineChart({ points, labels, height = 200 }: Props) {
  const w = 640;
  const h = height;
  const padX = 24;
  const padY = 20;
  const max = Math.max(...points, 1) * 1.15;
  const stepX = (w - padX * 2) / (points.length - 1);
  const xy = points.map((p, i) => [padX + i * stepX, h - padY - (p / max) * (h - padY * 2)] as const);

  // Catmull-Rom → cubic bezier smoothing
  const path = xy
    .map((pt, i, a) => {
      if (i === 0) return `M ${pt[0]},${pt[1]}`;
      const p0 = a[i - 1]!;
      const cx = (p0[0] + pt[0]) / 2;
      return `C ${cx},${p0[1]} ${cx},${pt[1]} ${pt[0]},${pt[1]}`;
    })
    .join(' ');
  const area = `${path} L ${xy[xy.length - 1]![0]},${h - padY} L ${xy[0]![0]},${h - padY} Z`;

  // peak marker
  const peakIdx = points.indexOf(Math.max(...points));
  const peak = xy[peakIdx]!;

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} role="img">
      <defs>
        <linearGradient id="lcLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ff7ab0" />
          <stop offset="100%" stopColor="#ff3d8b" />
        </linearGradient>
        <linearGradient id="lcArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(255,61,139,0.18)" />
          <stop offset="100%" stopColor="rgba(255,61,139,0)" />
        </linearGradient>
      </defs>
      {/* gridlines */}
      {[0, 0.5, 1].map((g) => (
        <line
          key={g}
          x1={padX}
          x2={w - padX}
          y1={padY + g * (h - padY * 2)}
          y2={padY + g * (h - padY * 2)}
          stroke="rgba(40,36,56,0.06)"
          strokeWidth={1}
        />
      ))}
      <path d={area} fill="url(#lcArea)" />
      <path d={path} fill="none" stroke="url(#lcLine)" strokeWidth={3} strokeLinecap="round" />
      <circle cx={peak[0]} cy={peak[1]} r={5} fill="#fff" stroke="#ff3d8b" strokeWidth={3} />
      {labels.map((l, i) => (
        <text
          key={l}
          x={padX + i * stepX}
          y={h - 2}
          textAnchor="middle"
          fontSize="10"
          fill="rgba(40,36,56,0.36)"
          fontFamily="var(--font-sans)"
        >
          {l}
        </text>
      ))}
    </svg>
  );
}
