import type { AttendanceMinimumsEra } from '@grind/types';

interface Minimums {
  fullDayMinMinutes: number;
  halfDayMinMinutes: number;
}

/**
 * The minimums history after an admin saves new minimums that apply from
 * `from` on.
 *
 * The pair in force until now becomes an era ending at `from`, so every date
 * before it keeps being judged on the numbers it was judged on. Saving the same
 * numbers changes nothing. Correcting the numbers again on or after the last
 * change's date only replaces the current pair — the earlier eras stay. A date
 * before the last change would rewrite a period another change already
 * settled, so it is refused.
 */
export function nextMinimumsHistory(input: {
  current: Minimums;
  history: readonly AttendanceMinimumsEra[];
  next: Minimums;
  from: string;
}): { changed: boolean; eras: AttendanceMinimumsEra[] } | { error: 'minimums_from_before_last_change' } {
  const eras = [...input.history];
  const same =
    input.current.fullDayMinMinutes === input.next.fullDayMinMinutes &&
    input.current.halfDayMinMinutes === input.next.halfDayMinMinutes;
  if (same) return { changed: false, eras };

  const last = eras[eras.length - 1];
  if (last && input.from < last.until) return { error: 'minimums_from_before_last_change' };
  if (last && input.from === last.until) return { changed: false, eras };

  eras.push({ until: input.from, ...input.current });
  return { changed: true, eras };
}
