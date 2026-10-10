/**
 * Activity percent — one definition for every surface (desktop gallery bars,
 * dashboard reports).
 *
 * A percent of activity is an average over the minutes a person was TRACKED,
 * not over the minutes that happened to produce a sample. Older agents stored
 * nothing for a quiet minute, so dividing by stored samples read one busy
 * minute out of ten as 100%. Zero-activity minutes are stored now, and the
 * server additionally knows tracked time from the timer itself.
 */
export interface TrackedMinutes {
  /** Minutes with a stored sample in the window (zero-activity minutes included). */
  sampledMinutes: number;
  /**
   * Minutes the timer was tracking in the window, when the caller knows them.
   * Null/undefined: the stored samples are the best measure available.
   */
  trackedMinutes?: number | null;
  /**
   * Sampled minutes that registered any activity. Such a minute was tracked by
   * definition, so it bounds the denominator from below when tracked time is
   * rounded or clipped at the window's edges.
   */
  activeMinutes?: number;
}

/** The number of minutes an activity average is taken over. */
export function trackedMinuteCount(m: TrackedMinutes): number {
  const tracked = m.trackedMinutes ?? 0;
  if (tracked <= 0) return Math.max(0, m.sampledMinutes);
  return Math.max(tracked, m.activeMinutes ?? 0);
}

/** `total` spread over the tracked minutes (0 when there were none). */
export function perTrackedMinute(total: number, m: TrackedMinutes): number {
  const minutes = trackedMinuteCount(m);
  return minutes > 0 ? total / minutes : 0;
}

/**
 * 0–100 activity score from per-minute scores in [0, 1], averaged over tracked
 * minutes. Null when nothing was tracked.
 */
export function activityPercentOverTrackedMinutes(scoreSum: number, m: TrackedMinutes): number | null {
  const minutes = trackedMinuteCount(m);
  if (minutes <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((100 * scoreSum) / minutes)));
}
