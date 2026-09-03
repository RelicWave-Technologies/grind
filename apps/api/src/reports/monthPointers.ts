import type { ShiftSchedule } from '@grind/types';
import { weekdayForDate } from '../leave';
import type { MonthPerformanceDay } from './monthPerformance';

/**
 * Month pointers — one performance verdict per person per month.
 *
 * The month report says what each day was. This says what the month amounted
 * to: how many days fell short, how many stood out, and one band for the month
 * as a whole. It is the layer a manager reads when they are not going to read
 * thirty-one columns.
 *
 * ## Where the numbers come from
 *
 * Every figure is derived from the month report's own days, so a pointer can
 * never disagree with the grid it summarises. Hours are Timo's tracked time —
 * the same measure the grid's WORK row prints. Arrival and departure come from
 * the punch record, compared against the person's own shift window.
 *
 * ## Days that count
 *
 * Only days the person actually worked — `P` and `HD`. Leave, weekly offs and
 * holidays are excluded rather than counted as zero: a month with a week of
 * approved leave is not a month of bad performance, and averaging zeros in
 * would say it was. Absences are excluded for the same reason and are already
 * counted on their own in the report's totals.
 *
 * ## The band
 *
 * Read off the average alone, because that is the one figure that describes the
 * month rather than a handful of days inside it. The spec fixed both outer
 * edges — under 7h is critical, above 8h15 is good — and described the middle
 * as "around 8 hours"; that is taken as everything between the two edges, so
 * the bands tile the range with no day landing outside all three.
 *
 * A month with no worked days gets no band at all. Twenty-one people in August
 * had not worked a single day, and banding them on a 0:00 average called them
 * critical when what was true is that there is nothing to judge.
 */

/** Minutes. Named for the spec line each one comes from. */
export const POINTER_THRESHOLDS = {
  /** "Full-day attendance mein agar working 6 ghante se kam hai" */
  fullDayShortOf: 6 * 60,
  /** "Half-day attendance mein agar 2 ghante ya usse kam" — inclusive. */
  halfDayShortOf: 2 * 60,
  /** "Full-day mein 9 ghante ya usse zyada" — inclusive. */
  fullDayStrongFrom: 9 * 60,
  /** "Half-day mein 5 ghante se zyada" — exclusive. */
  halfDayStrongOver: 5 * 60,
  /** "sabhi working days ka average 7 ghante se kam" */
  averageCriticalUnder: 7 * 60,
  /** "average 8 ghante 15 minute se zyada" */
  averageStrongOver: 8 * 60 + 15,
} as const;

export type PerformanceBand = 'RED' | 'YELLOW' | 'GREEN';

export interface MonthPointers {
  /** `P` + `HD` days. The denominator of the average. */
  workedDays: number;
  fullDays: number;
  halfDays: number;
  /** Sum of tracked minutes over `workedDays`. */
  workMinutes: number;
  /** Rounded to the minute. 0 when nothing was worked. */
  averageMinutes: number;
  /** null when the month has no worked days — nothing to judge, not "critical". */
  band: PerformanceBand | null;

  /** "Total Full Working Days Less Than 6 Hours" */
  fullDaysUnderSix: number;
  /** "Total Half Working Days – 2 Hours or Less" */
  halfDaysUpToTwo: number;
  /** "Total Full Working Days – 9 Hours or More" */
  fullDaysNineOrMore: number;
  /** "Total Half Working Days – More Than 5 Hours" */
  halfDaysOverFive: number;

  /**
   * Days punched in after the shift's start time, and after that start plus the
   * shift's grace buffer.
   *
   * Both are kept because they answer different questions and the workspace has
   * not said which one it means by "late". Against General Shift's 09:00 most
   * of the company is late most days — the median arrival is 09:32 — which
   * flags everyone and so flags nobody. Against 09:00 + 30m the count separates
   * people who are late from people who are ordinary.
   */
  lateDays: number;
  lateDaysAfterBuffer: number;
  /** Days punched out before the shift's end time. */
  earlyDays: number;
  /**
   * Worked days with no usable punch pair, so late and early could not be
   * judged. Reported rather than folded into the counts: a person the biometric
   * machine missed would otherwise read as never late and never early.
   */
  daysWithoutPunch: number;
}

export interface MonthPointerInput {
  /** The month report's days for one person. Each day carries its own date. */
  days: readonly MonthPerformanceDay[];
  /** The person's shift. null = no shift, so no arrival or departure to judge. */
  schedule: ShiftSchedule | null;
  /** Grace after the shift start that still counts as on time. */
  bufferMin: number;
}

function bandFor(averageMinutes: number, workedDays: number): PerformanceBand | null {
  if (workedDays === 0) return null;
  if (averageMinutes < POINTER_THRESHOLDS.averageCriticalUnder) return 'RED';
  if (averageMinutes > POINTER_THRESHOLDS.averageStrongOver) return 'GREEN';
  return 'YELLOW';
}

function hhmmToMinutes(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!m?.[1] || !m[2]) return null;
  return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
}

export function buildMonthPointers(input: MonthPointerInput): MonthPointers {
  const t = POINTER_THRESHOLDS;
  const out: MonthPointers = {
    workedDays: 0, fullDays: 0, halfDays: 0, workMinutes: 0, averageMinutes: 0, band: null,
    fullDaysUnderSix: 0, halfDaysUpToTwo: 0, fullDaysNineOrMore: 0, halfDaysOverFive: 0,
    lateDays: 0, lateDaysAfterBuffer: 0, earlyDays: 0, daysWithoutPunch: 0,
  };

  for (const day of input.days) {
    const isFull = day.code === 'P';
    const isHalf = day.code === 'HD';
    if (!isFull && !isHalf) continue;

    out.workedDays += 1;
    out.workMinutes += day.workMinutes;

    if (isFull) {
      out.fullDays += 1;
      if (day.workMinutes < t.fullDayShortOf) out.fullDaysUnderSix += 1;
      if (day.workMinutes >= t.fullDayStrongFrom) out.fullDaysNineOrMore += 1;
    } else {
      out.halfDays += 1;
      if (day.workMinutes <= t.halfDayShortOf) out.halfDaysUpToTwo += 1;
      if (day.workMinutes > t.halfDayStrongOver) out.halfDaysOverFive += 1;
    }

    // Arrival and departure need a window to be judged against. A day the shift
    // calls off has none — and neither does a person with no shift at all.
    const window = input.schedule ? input.schedule[weekdayForDate(day.date)] : null;
    if (!window) continue;

    if (day.punchInMinute == null || day.punchOutMinute == null) {
      out.daysWithoutPunch += 1;
      continue;
    }

    const start = hhmmToMinutes(window.start);
    const end = hhmmToMinutes(window.end);
    if (start == null || end == null) continue;

    if (day.punchInMinute > start) out.lateDays += 1;
    if (day.punchInMinute > start + input.bufferMin) out.lateDaysAfterBuffer += 1;
    if (day.punchOutMinute < end) out.earlyDays += 1;
  }

  out.averageMinutes = out.workedDays === 0 ? 0 : Math.round(out.workMinutes / out.workedDays);
  out.band = bandFor(out.averageMinutes, out.workedDays);
  return out;
}
