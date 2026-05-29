/**
 * Role-based scoring presets.
 *
 * Productivity is content-free: we only ever see per-minute COUNTS
 * (keystrokes, clicks, scroll events, mouse-travel px) plus timing CVs. A role
 * preset says, for that kind of work, what per-minute volume on each channel
 * counts as "fully engaged" (the saturation) and how much each channel matters
 * (the weight). Weights sum to 1 so a minute's intensity lands in [0, 1].
 *
 * These are research-seeded starting points; the plan calls for tuning the
 * saturations against real cohort data after ~30 days. Keep them conservative:
 * saturations that are too low make everyone look maxed-out (no signal).
 */

export type RoleTitle = 'DEVELOPER' | 'DESIGNER' | 'SALES' | 'OTHER';

export type Channel = 'keystrokes' | 'clicks' | 'scrollEvents' | 'mouseDistancePx';

export interface RolePreset {
  /** Per-minute volume on each channel that maps to a fully-engaged (1.0) channel. */
  saturation: Record<Channel, number>;
  /** Channel weights; MUST sum to 1. */
  weight: Record<Channel, number>;
}

export const ROLE_PRESETS: Record<RoleTitle, RolePreset> = {
  // Heavy keyboard, moderate mouse.
  DEVELOPER: {
    saturation: { keystrokes: 300, clicks: 60, scrollEvents: 40, mouseDistancePx: 6000 },
    weight: { keystrokes: 0.5, clicks: 0.2, scrollEvents: 0.15, mouseDistancePx: 0.15 },
  },
  // Mouse/click-heavy (canvas work), lighter typing.
  DESIGNER: {
    saturation: { keystrokes: 120, clicks: 120, scrollEvents: 60, mouseDistancePx: 12000 },
    weight: { keystrokes: 0.25, clicks: 0.3, scrollEvents: 0.15, mouseDistancePx: 0.3 },
  },
  // Comms-heavy; balanced with a typing lean.
  SALES: {
    saturation: { keystrokes: 200, clicks: 80, scrollEvents: 50, mouseDistancePx: 8000 },
    weight: { keystrokes: 0.4, clicks: 0.25, scrollEvents: 0.15, mouseDistancePx: 0.2 },
  },
  // Sensible default for everyone else.
  OTHER: {
    saturation: { keystrokes: 200, clicks: 60, scrollEvents: 40, mouseDistancePx: 8000 },
    weight: { keystrokes: 0.4, clicks: 0.25, scrollEvents: 0.15, mouseDistancePx: 0.2 },
  },
};

export function presetFor(role: RoleTitle | null | undefined): RolePreset {
  return ROLE_PRESETS[role ?? 'OTHER'] ?? ROLE_PRESETS.OTHER;
}
