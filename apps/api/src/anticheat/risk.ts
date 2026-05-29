/**
 * Anti-cheat risk engine — pure and content-free.
 *
 * Works entirely off the per-minute aggregates we already capture (counts +
 * timing/geometry CVs). It raises auditable, employee-visible FLAGS for
 * manager review; it NEVER deletes time. The only hard action is rejecting a
 * physically-impossible interval (IMPOSSIBLE_RATE) — a human cannot type
 * >1100 keystrokes in a minute, so that interval is not credited.
 *
 * Signals implemented here (from research §2):
 *   - IMPOSSIBLE_RATE  keystrokes/min beyond human capacity  → hard reject
 *   - METRONOMIC       inter-keystroke interval CV ≈ 0 (robotic cadence)
 *   - LINEAR_MOUSE     dead-straight path + constant speed (scripted mouse)
 *   - SINGLE_CHANNEL   only keyboard XOR only pointer, ever (bot driving one)
 *   - JIGGLER          movement-only, no clicks/keys/scroll, fixed cadence
 *
 * Deferred (need data not yet captured):
 *   - STATIC_SCREEN    median pairwise screenshot pHash Hamming ≤5  (needs M4b)
 *   - FIXED_INTERVAL   event-gap grid clustering (needs fixedIntervalScore)
 */

export type FlagType =
  | 'IMPOSSIBLE_RATE'
  | 'METRONOMIC'
  | 'LINEAR_MOUSE'
  | 'SINGLE_CHANNEL'
  | 'JIGGLER';

export interface RiskSample {
  keystrokes: number;
  clicks: number;
  scrollEvents: number;
  mouseDistancePx: number;
  ikiCv?: number | null;
  moveSpeedCv?: number | null;
  pathStraightness?: number | null;
}

export interface RiskFlag {
  type: FlagType;
  /** 0–100 contribution to the window's cumulative risk. */
  riskScore: number;
  /** Content-free evidence for the review queue. */
  evidence: Record<string, number>;
}

export interface WindowAssessment {
  hardReject: boolean; // an IMPOSSIBLE_RATE minute was present
  riskScore: number; // cumulative, capped at 100
  flags: RiskFlag[];
}

// --- Tunable thresholds (exported so the review UI / tests reference one source) ---
export const IMPOSSIBLE_KEYS_PER_MIN = 1100;
export const METRONOMIC_IKI_CV = 0.1;
export const MIN_KEYS_FOR_IKI = 30;
export const LINEAR_STRAIGHTNESS = 0.97;
export const LINEAR_SPEED_CV = 0.05;
export const MIN_MOVE_PX = 500;
export const JIGGLER_SPEED_CV = 0.1;
export const IDLE_MOUSE_PX = 50;
export const MIN_WINDOW_FOR_PATTERN = 5; // need enough minutes to claim a pattern
export const SINGLE_CHANNEL_MIN_VOLUME = 200; // total of the active channel

export const RISK_WEIGHTS: Record<FlagType, number> = {
  IMPOSSIBLE_RATE: 100,
  JIGGLER: 45,
  METRONOMIC: 40,
  LINEAR_MOUSE: 35,
  SINGLE_CHANNEL: 20,
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function flag(type: FlagType, evidence: Record<string, number>): RiskFlag {
  return { type, riskScore: RISK_WEIGHTS[type], evidence };
}

function impossibleRate(w: RiskSample[]): RiskFlag | null {
  const offenders = w.filter((s) => s.keystrokes > IMPOSSIBLE_KEYS_PER_MIN);
  if (offenders.length === 0) return null;
  const peak = Math.max(...offenders.map((s) => s.keystrokes));
  return flag('IMPOSSIBLE_RATE', { offendingMinutes: offenders.length, peakKeysPerMin: peak });
}

function metronomic(w: RiskSample[]): RiskFlag | null {
  const typing = w.filter((s) => s.keystrokes >= MIN_KEYS_FOR_IKI && s.ikiCv != null);
  if (typing.length < MIN_WINDOW_FOR_PATTERN) return null;
  const robotic = typing.filter((s) => (s.ikiCv as number) < METRONOMIC_IKI_CV);
  // Majority of substantive typing minutes are metronomic.
  if (robotic.length / typing.length < 0.5) return null;
  return flag('METRONOMIC', {
    typingMinutes: typing.length,
    roboticMinutes: robotic.length,
    medianIkiCv: Number(median(typing.map((s) => s.ikiCv as number)).toFixed(4)),
  });
}

function linearMouse(w: RiskSample[]): RiskFlag | null {
  const moving = w.filter(
    (s) => s.mouseDistancePx >= MIN_MOVE_PX && s.pathStraightness != null && s.moveSpeedCv != null,
  );
  if (moving.length < MIN_WINDOW_FOR_PATTERN) return null;
  const scripted = moving.filter(
    (s) => (s.pathStraightness as number) >= LINEAR_STRAIGHTNESS && (s.moveSpeedCv as number) <= LINEAR_SPEED_CV,
  );
  if (scripted.length / moving.length < 0.5) return null;
  return flag('LINEAR_MOUSE', {
    movingMinutes: moving.length,
    scriptedMinutes: scripted.length,
    medianStraightness: Number(median(moving.map((s) => s.pathStraightness as number)).toFixed(4)),
  });
}

function singleChannel(w: RiskSample[]): RiskFlag | null {
  if (w.length < MIN_WINDOW_FOR_PATTERN) return null;
  const totals = w.reduce(
    (a, s) => ({
      keys: a.keys + s.keystrokes,
      clicks: a.clicks + s.clicks,
      scroll: a.scroll + s.scrollEvents,
      mouse: a.mouse + s.mouseDistancePx,
    }),
    { keys: 0, clicks: 0, scroll: 0, mouse: 0 },
  );
  const pointerActivity = totals.clicks + totals.scroll + (totals.mouse > IDLE_MOUSE_PX * w.length ? 1 : 0);
  // Keyboard-only: lots of typing, zero pointer activity for the whole window.
  if (totals.keys >= SINGLE_CHANNEL_MIN_VOLUME && totals.clicks === 0 && totals.scroll === 0 && totals.mouse <= IDLE_MOUSE_PX * w.length) {
    return flag('SINGLE_CHANNEL', { channel: 0 /* keyboard */, totalKeys: totals.keys });
  }
  // Pointer-only: real clicking/movement, zero keystrokes for the whole window.
  if (totals.keys === 0 && totals.clicks + totals.mouse >= SINGLE_CHANNEL_MIN_VOLUME && pointerActivity > 0) {
    return flag('SINGLE_CHANNEL', { channel: 1 /* pointer */, totalClicks: totals.clicks, totalMousePx: totals.mouse });
  }
  return null;
}

function jiggler(w: RiskSample[]): RiskFlag | null {
  if (w.length < MIN_WINDOW_FOR_PATTERN) return null;
  // Every minute: movement present, but no clicks/keys/scroll at all.
  const moveOnly = w.filter(
    (s) => s.mouseDistancePx > IDLE_MOUSE_PX && s.keystrokes === 0 && s.clicks === 0 && s.scrollEvents === 0,
  );
  if (moveOnly.length / w.length < 0.8) return null; // must dominate the window
  // Fixed cadence: low speed variation across the move-only minutes.
  const cvs = moveOnly.map((s) => s.moveSpeedCv).filter((v): v is number => v != null);
  if (cvs.length > 0 && median(cvs) > JIGGLER_SPEED_CV) return null;
  return flag('JIGGLER', {
    moveOnlyMinutes: moveOnly.length,
    windowMinutes: w.length,
    medianSpeedCv: cvs.length ? Number(median(cvs).toFixed(4)) : -1,
  });
}

/**
 * Assess a window (chronological run) of per-minute samples. Returns the raised
 * flags, the cumulative risk (capped 100), and whether any interval must be
 * hard-rejected. An empty window is clean.
 */
export function assessWindow(window: RiskSample[]): WindowAssessment {
  const flags: RiskFlag[] = [];
  for (const detect of [impossibleRate, metronomic, linearMouse, singleChannel, jiggler]) {
    const f = detect(window);
    if (f) flags.push(f);
  }
  const riskScore = Math.min(100, flags.reduce((a, f) => a + f.riskScore, 0));
  const hardReject = flags.some((f) => f.type === 'IMPOSSIBLE_RATE');
  return { hardReject, riskScore, flags };
}
