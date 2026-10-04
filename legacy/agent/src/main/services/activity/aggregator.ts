/**
 * Pure per-minute activity aggregator (no Electron), so it's fully unit-testable.
 *
 * PRIVACY: counts and timing/geometry stats ONLY — never key identity, never
 * text, never clipboard. The timing CVs are content-free and exist to power
 * anti-cheat (M8): metronomic/scripted input has near-zero variance, humans are
 * bursty (high variance); straight-line constant-velocity mouse paths are bots.
 */

export interface ActivitySample {
  bucketStart: number;
  keystrokes: number;
  clicks: number;
  mouseDistancePx: number;
  scrollEvents: number;
  /** coefficient of variation (σ/μ) of inter-keystroke intervals; null if <3 keys */
  ikiCv: number | null;
  /** CV of pointer speed across move samples; null if <3 moves */
  moveSpeedCv: number | null;
  /** euclidean(first,last)/path-length over the minute (≈1 = straight line); null if no movement */
  pathStraightness: number | null;
}

/** Coefficient of variation (population). null if <2 values or mean 0. */
export function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export class ActivityAggregator {
  private keystrokes = 0;
  private clicks = 0;
  private scrollEvents = 0;
  private mouseDistancePx = 0;

  private keyTimes: number[] = [];
  private moveSpeeds: number[] = [];
  private last: { t: number; x: number; y: number } | null = null;
  private first: { x: number; y: number } | null = null;

  onKey(ts: number): void {
    this.keystrokes += 1;
    this.keyTimes.push(ts);
  }

  onClick(): void {
    this.clicks += 1;
  }

  onScroll(): void {
    this.scrollEvents += 1;
  }

  onMove(ts: number, x: number, y: number): void {
    if (this.first === null) this.first = { x, y };
    if (this.last) {
      const dx = x - this.last.x;
      const dy = y - this.last.y;
      const dist = Math.hypot(dx, dy);
      this.mouseDistancePx += dist;
      const dt = ts - this.last.t;
      if (dt > 0) this.moveSpeeds.push(dist / dt);
    }
    this.last = { t: ts, x, y };
  }

  /** Emit the sample for this bucket and reset for the next minute. */
  flush(bucketStart: number): ActivitySample {
    const intervals: number[] = [];
    for (let i = 1; i < this.keyTimes.length; i++) {
      intervals.push(this.keyTimes[i]! - this.keyTimes[i - 1]!);
    }

    let pathStraightness: number | null = null;
    if (this.first && this.last && this.mouseDistancePx > 0) {
      const euclid = Math.hypot(this.last.x - this.first.x, this.last.y - this.first.y);
      pathStraightness = euclid / this.mouseDistancePx;
    }

    const sample: ActivitySample = {
      bucketStart,
      keystrokes: this.keystrokes,
      clicks: this.clicks,
      mouseDistancePx: Math.round(this.mouseDistancePx),
      scrollEvents: this.scrollEvents,
      ikiCv: coefficientOfVariation(intervals),
      moveSpeedCv: coefficientOfVariation(this.moveSpeeds),
      pathStraightness,
    };
    this.reset();
    return sample;
  }

  /** True if nothing happened this bucket (used to skip empty samples). */
  isEmpty(): boolean {
    return (
      this.keystrokes === 0 &&
      this.clicks === 0 &&
      this.scrollEvents === 0 &&
      this.mouseDistancePx === 0 &&
      this.moveSpeeds.length === 0
    );
  }

  private reset(): void {
    this.keystrokes = 0;
    this.clicks = 0;
    this.scrollEvents = 0;
    this.mouseDistancePx = 0;
    this.keyTimes = [];
    this.moveSpeeds = [];
    this.last = null;
    this.first = null;
  }
}
