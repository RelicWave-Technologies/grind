import { perTrackedMinute } from '@grind/core';

/**
 * Turn a window's summed activity into 0–100% keyboard + mouse intensity bars
 * (Hubstaff-style per-screenshot indicator). Pure + content-free.
 *
 * Saturations are per-minute "fully active" rates; we average over the window's
 * TRACKED minutes (the shared definition in @grind/core) — quiet tracked
 * minutes are stored as zeros, so a quiet stretch reads low and a busy one
 * maxes out.
 */

export const KEYS_SAT_PER_MIN = 120; // ~2 keys/sec sustained = 100%
export const CLICKS_SAT_PER_MIN = 40;
export const SCROLL_SAT_PER_MIN = 40;
export const MOUSE_PX_SAT_PER_MIN = 6000;

export interface ActivityWindow {
  /** Stored minutes, zero-activity tracked minutes included. */
  minutes: number;
  /** Tracked minutes when known independently of the samples. */
  trackedMinutes?: number | null;
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
  const minutes = { sampledMinutes: w.minutes, trackedMinutes: w.trackedMinutes };
  const keyboard = clampPct((perTrackedMinute(w.keystrokes, minutes) / KEYS_SAT_PER_MIN) * 100);
  // Mouse blends clicks, scroll, and travel; the channel that's busiest wins,
  // so either lots of clicks OR lots of movement reads as active.
  const clicksPm = perTrackedMinute(w.clicks, minutes) / CLICKS_SAT_PER_MIN;
  const scrollPm = perTrackedMinute(w.scrollEvents, minutes) / SCROLL_SAT_PER_MIN;
  const distPm = perTrackedMinute(w.mouseDistancePx, minutes) / MOUSE_PX_SAT_PER_MIN;
  const mouse = clampPct(Math.max(clicksPm, scrollPm, distPm) * 100);
  return { keyboard, mouse };
}
