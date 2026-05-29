/**
 * Turn a window's summed activity into 0–100% keyboard + mouse intensity bars
 * (Hubstaff-style per-screenshot indicator). Pure + content-free.
 *
 * Saturations are per-minute "fully active" rates; we average over the window's
 * captured minutes so a quiet stretch reads low and a busy one maxes out.
 */

export const KEYS_SAT_PER_MIN = 120; // ~2 keys/sec sustained = 100%
export const CLICKS_SAT_PER_MIN = 40;
export const SCROLL_SAT_PER_MIN = 40;
export const MOUSE_PX_SAT_PER_MIN = 6000;

export interface ActivityWindow {
  minutes: number;
  keystrokes: number;
  clicks: number;
  mouseDistancePx: number;
  scrollEvents: number;
}

export interface ActivityPercent {
  keyboard: number; // 0–100
  mouse: number; // 0–100
}

const clampPct = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

export function activityPercent(w: ActivityWindow): ActivityPercent {
  if (!w || w.minutes <= 0) return { keyboard: 0, mouse: 0 };
  const keyboard = clampPct((w.keystrokes / w.minutes / KEYS_SAT_PER_MIN) * 100);
  // Mouse blends clicks, scroll, and travel; the channel that's busiest wins,
  // so either lots of clicks OR lots of movement reads as active.
  const clicksPm = w.clicks / w.minutes / CLICKS_SAT_PER_MIN;
  const scrollPm = w.scrollEvents / w.minutes / SCROLL_SAT_PER_MIN;
  const distPm = w.mouseDistancePx / w.minutes / MOUSE_PX_SAT_PER_MIN;
  const mouse = clampPct(Math.max(clicksPm, scrollPm, distPm) * 100);
  return { keyboard, mouse };
}
