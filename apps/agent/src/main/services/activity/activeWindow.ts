/**
 * Pure dominant-active-window tracker (M14). Polled by the meeting/window
 * service at ~10s cadence; on each minute flush, the activity index asks
 * `dominantFor(bucketStart)` for the app that owned the most wall-clock
 * time within the last minute. That sample is attached to the
 * ActivitySample that gets uploaded.
 *
 * Two design choices worth flagging:
 *  - We tally **time** between consecutive ticks, NOT tick counts. A user
 *    who flips between Chrome (10s) and VS Code (50s) should land VS
 *    Code, even if both received the same number of polls.
 *  - title + url are captured opportunistically from the *winning* app's
 *    last observation in the minute, so they line up with whoever wins
 *    the "dominant" tally. Backend scrubs them per policy regardless.
 */

export interface ActiveWindowObservation {
  ts: number; // epoch ms
  app: string | null;
  appBundle: string | null;
  title: string | null;
  url: string | null;
}

export interface DominantWindow {
  activeApp: string | null;
  activeAppBundle: string | null;
  activeTitle: string | null;
  activeUrl: string | null;
}

export class ActiveWindowTracker {
  private observations: ActiveWindowObservation[] = [];
  /** Hard cap: at 10s cadence one minute has 6 samples; keep ~5 minutes worth. */
  private readonly maxObservations: number;

  constructor(maxObservations = 60) {
    this.maxObservations = maxObservations;
  }

  /** Record one polled active-window sample. */
  observe(obs: ActiveWindowObservation): void {
    this.observations.push(obs);
    // Drop the oldest if we've blown the cap.
    if (this.observations.length > this.maxObservations) {
      this.observations.splice(0, this.observations.length - this.maxObservations);
    }
  }

  /**
   * Pick the dominant (app, bundle) over `[bucketStart, bucketEnd)`. Time
   * attributed to each tick = duration to the NEXT tick (or `bucketEnd`
   * for the last in-window tick), clipped to the bucket. Falls back to
   * the most recent observation if none lie inside the bucket — better
   * than emitting null when the user just hasn't switched apps.
   */
  dominantFor(bucketStart: number, bucketEnd: number): DominantWindow {
    const empty: DominantWindow = {
      activeApp: null,
      activeAppBundle: null,
      activeTitle: null,
      activeUrl: null,
    };
    if (this.observations.length === 0) return empty;

    // Sort defensively — observations should already be append-order.
    const obs = [...this.observations].sort((a, b) => a.ts - b.ts);

    // Find the observation that was "live" at bucketStart (the latest tick
    // at or before bucketStart) plus everything within the bucket.
    let priorIdx = -1;
    for (let i = 0; i < obs.length; i++) {
      if (obs[i]!.ts <= bucketStart) priorIdx = i;
      else break;
    }

    // Walk forward, attributing time slices to (app, bundle) keys.
    type Tally = { ms: number; lastObs: ActiveWindowObservation };
    const tallies = new Map<string, Tally>();
    const keyFor = (o: ActiveWindowObservation) => `${o.app ?? ''}${o.appBundle ?? ''}`;

    const slices: Array<{ from: number; to: number; obs: ActiveWindowObservation }> = [];
    const startObs = priorIdx >= 0 ? obs[priorIdx]! : obs[0]!;
    let cursorObs: ActiveWindowObservation = startObs;
    let cursorTs = Math.max(bucketStart, priorIdx >= 0 ? bucketStart : startObs.ts);

    const inBucket = obs.filter((o) => o.ts > bucketStart && o.ts < bucketEnd);
    for (const next of inBucket) {
      if (next.ts > cursorTs) slices.push({ from: cursorTs, to: next.ts, obs: cursorObs });
      cursorObs = next;
      cursorTs = next.ts;
    }
    if (cursorTs < bucketEnd) slices.push({ from: cursorTs, to: bucketEnd, obs: cursorObs });

    // Only count slices where the app is known.
    let anySliceCounted = false;
    for (const s of slices) {
      const dur = s.to - s.from;
      if (dur <= 0) continue;
      if (!s.obs.app && !s.obs.appBundle) continue;
      anySliceCounted = true;
      const key = keyFor(s.obs);
      const t = tallies.get(key);
      if (t) {
        t.ms += dur;
        t.lastObs = s.obs;
      } else {
        tallies.set(key, { ms: dur, lastObs: s.obs });
      }
    }

    if (!anySliceCounted) {
      // Fall back to the most recent observation overall (e.g. agent
      // just started this minute — no slices fit but we still know what
      // the user is doing).
      const last = obs[obs.length - 1]!;
      if (!last.app && !last.appBundle) return empty;
      return {
        activeApp: last.app,
        activeAppBundle: last.appBundle,
        activeTitle: last.title,
        activeUrl: last.url,
      };
    }

    let winner: Tally | null = null;
    for (const t of tallies.values()) {
      if (!winner || t.ms > winner.ms) winner = t;
    }
    if (!winner) return empty;
    return {
      activeApp: winner.lastObs.app,
      activeAppBundle: winner.lastObs.appBundle,
      activeTitle: winner.lastObs.title,
      activeUrl: winner.lastObs.url,
    };
  }

  /** Drop everything older than `before` — call on minute flush to bound memory. */
  prune(before: number): void {
    if (this.observations.length === 0) return;
    // Keep the latest pre-`before` observation as the anchor for the next
    // bucket (so the first slice attributes time correctly), drop the
    // rest.
    let anchor: ActiveWindowObservation | null = null;
    const kept: ActiveWindowObservation[] = [];
    for (const o of this.observations) {
      if (o.ts < before) {
        anchor = o;
      } else {
        kept.push(o);
      }
    }
    this.observations = anchor ? [anchor, ...kept] : kept;
  }

  /** Count current observations (for tests / diagnostics). */
  size(): number {
    return this.observations.length;
  }

  /** Drop all cached observations, used when capture policy tightens. */
  clear(): void {
    this.observations = [];
  }
}
