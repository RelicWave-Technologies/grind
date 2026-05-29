import { presetFor, type RolePreset, type RoleTitle, type Channel } from './presets';

/**
 * Productivity scoring — pure, content-free.
 *
 * Pipeline (cold-start / saturation-normalized; cohort-percentile ranking is a
 * later refinement that plugs in at {@link scoreMinute}'s return):
 *   1. squash each channel: s_c = min(1, value_c / saturation_c[role])
 *   2. intensity = Σ weight_c · s_c   (weights sum to 1 → intensity ∈ [0,1])
 *   3. classify the minute: idle → 0, protected meeting → full credit,
 *      low-input-but-reading → reading credit, else intensity.
 *   4. day score = 100 · Σ(minute_score) / trackedMinutes.
 *
 * "Never zero unless truly idle": a tracked minute with any real input gets at
 * least its intensity; meetings and reading are explicitly credited so quiet
 * focused work isn't punished.
 */

export interface MinuteActivity {
  keystrokes: number;
  clicks: number;
  scrollEvents: number;
  mouseDistancePx: number;
}

export interface MinuteContext {
  /** In a detected meeting — present but not necessarily typing. Full credit. */
  isProtectedMeeting?: boolean;
}

export const FULL_CREDIT = 1;
export const READING_CREDIT = 0.5;
// Below this intensity, scrolling alone counts as reading/review.
const READING_INTENSITY_CEIL = 0.2;
const READING_SCROLL_MIN = 8;
// A minute is "idle" only when there is essentially no input of any kind.
const IDLE_MOUSE_PX = 50;

const CHANNELS: Channel[] = ['keystrokes', 'clicks', 'scrollEvents', 'mouseDistancePx'];

export function isIdleMinute(m: MinuteActivity): boolean {
  return (
    m.keystrokes === 0 &&
    m.clicks === 0 &&
    m.scrollEvents === 0 &&
    m.mouseDistancePx <= IDLE_MOUSE_PX
  );
}

/** Weighted, saturation-normalized intensity in [0, 1] (ignores idle/meeting). */
export function minuteIntensity(m: MinuteActivity, preset: RolePreset): number {
  let intensity = 0;
  for (const c of CHANNELS) {
    const sat = preset.saturation[c];
    const squashed = sat > 0 ? Math.min(1, m[c] / sat) : 0;
    intensity += preset.weight[c] * squashed;
  }
  // Guard against tiny float drift past 1.
  return Math.max(0, Math.min(1, intensity));
}

/** Score a single minute in [0, 1] given the user's role and context. */
export function scoreMinute(
  m: MinuteActivity,
  opts: { role?: RoleTitle | null; ctx?: MinuteContext } = {},
): number {
  const ctx = opts.ctx ?? {};
  if (ctx.isProtectedMeeting) return FULL_CREDIT; // present in a meeting
  if (isIdleMinute(m)) return 0;
  const preset = presetFor(opts.role);
  const intensity = minuteIntensity(m, preset);
  // Reading/review: low active input but clearly scrolling through content.
  if (intensity < READING_INTENSITY_CEIL && m.scrollEvents >= READING_SCROLL_MIN) {
    return READING_CREDIT;
  }
  return intensity;
}

export interface DayScore {
  /** 0–100 productivity score across tracked minutes. */
  score: number;
  trackedMinutes: number;
  engagedMinutes: number; // minutes with score > 0 and not protected
  protectedMinutes: number; // meeting minutes
  idleMinutes: number; // tracked minutes scored 0 (and not protected)
  avgIntensity: number; // mean raw intensity over non-idle, non-protected minutes
}

/**
 * Aggregate a day's worth of per-minute samples into a 0–100 score + breakdown.
 * Each sample represents one tracked minute. Returns a zeroed result for an
 * empty day (no division-by-zero).
 */
export function scoreDay(
  minutes: Array<MinuteActivity & MinuteContext>,
  opts: { role?: RoleTitle | null } = {},
): DayScore {
  const tracked = minutes.length;
  if (tracked === 0) {
    return { score: 0, trackedMinutes: 0, engagedMinutes: 0, protectedMinutes: 0, idleMinutes: 0, avgIntensity: 0 };
  }
  const preset = presetFor(opts.role);
  let sum = 0;
  let protectedMinutes = 0;
  let idleMinutes = 0;
  let engagedMinutes = 0;
  let intensitySum = 0;
  let intensityCount = 0;

  for (const m of minutes) {
    const s = scoreMinute(m, { role: opts.role, ctx: { isProtectedMeeting: m.isProtectedMeeting } });
    sum += s;
    if (m.isProtectedMeeting) {
      protectedMinutes += 1;
    } else if (isIdleMinute(m)) {
      idleMinutes += 1;
    } else {
      engagedMinutes += 1;
      intensitySum += minuteIntensity(m, preset);
      intensityCount += 1;
    }
  }

  return {
    score: Math.round((100 * sum) / tracked),
    trackedMinutes: tracked,
    engagedMinutes,
    protectedMinutes,
    idleMinutes,
    avgIntensity: intensityCount > 0 ? intensitySum / intensityCount : 0,
  };
}
