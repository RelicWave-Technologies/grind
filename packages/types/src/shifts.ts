import { z } from 'zod';

/**
 * Shift scheduling — wire types shared between API, dashboard, and agent.
 *
 * A Shift is a weekly recurring schedule with an optional buffer window
 * during which the agent's "ready to work?" popup nudges the user every
 * 5 min after their start time.
 *
 * All times are stored as HH:MM strings (24-hour). The day-of-week is
 * resolved in the USER's local timezone, not the server's; the agent
 * does the matching when it decides whether to show the popup.
 */

/** Strict HH:MM 24-hour clock. "00:00" .. "23:59". */
export const HHMMSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'time must be HH:MM in 24-hour format');

/** A single day's working window, or null = day off. */
export const DayScheduleSchema = z
  .object({
    start: HHMMSchema,
    end: HHMMSchema,
  })
  .nullable()
  .refine((d) => d === null || hhmmToMin(d.end) > hhmmToMin(d.start), {
    message: 'end must be after start',
  });

export type DaySchedule = z.infer<typeof DayScheduleSchema>;

/** The full weekly schedule, with all 7 lowercase day keys required. */
export const ShiftScheduleSchema = z.object({
  mon: DayScheduleSchema,
  tue: DayScheduleSchema,
  wed: DayScheduleSchema,
  thu: DayScheduleSchema,
  fri: DayScheduleSchema,
  sat: DayScheduleSchema,
  sun: DayScheduleSchema,
});

export type ShiftSchedule = z.infer<typeof ShiftScheduleSchema>;

/** Server → client serialised shape. */
export const ShiftDtoSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  schedule: ShiftScheduleSchema,
  bufferMin: z.number().int().min(0).max(240),
  memberCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ShiftDto = z.infer<typeof ShiftDtoSchema>;

/** POST /v1/admin/shifts body. */
export const CreateShiftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  schedule: ShiftScheduleSchema,
  bufferMin: z.number().int().min(0).max(240).default(30),
});

export type CreateShift = z.infer<typeof CreateShiftSchema>;

/** PATCH /v1/admin/shifts/:id body. */
export const PatchShiftSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    schedule: ShiftScheduleSchema.optional(),
    bufferMin: z.number().int().min(0).max(240).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing_to_update' });

export type PatchShift = z.infer<typeof PatchShiftSchema>;

/** GET /v1/me/shift response (or null if unassigned). */
export const MyShiftResponseSchema = z.object({
  shift: ShiftDtoSchema.nullable(),
  assignedAt: z.string().nullable(),
});

export type MyShiftResponse = z.infer<typeof MyShiftResponseSchema>;

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — agent + dashboard both import these)
// ---------------------------------------------------------------------------

/** Lowercase weekday key used in ShiftSchedule. */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Convert HH:MM to minutes since 00:00. */
export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => Number.parseInt(n, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Compose HH:MM from minutes since 00:00. */
export function minToHhmm(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = ((min % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Resolve the weekday key (lowercase 'mon'..'sun') for a JS Date. */
export function weekdayKey(d: Date): Weekday {
  return WEEKDAYS[d.getDay()]!;
}

/** Get today's day-schedule from a Shift (or null = day off). */
export function todaysSchedule(schedule: ShiftSchedule, now: Date): DaySchedule {
  return schedule[weekdayKey(now)];
}

/**
 * Should the "ready to work?" popup fire **now**?
 *
 * The agent calls this every ~30s. Returns true iff:
 *   - today is a working day in the assigned shift, AND
 *   - now is between `start` and `start + bufferMin` (inclusive), AND
 *   - the user hasn't already acknowledged today's popup with "Yes"
 *     (that bookkeeping is the agent's responsibility — this helper is pure).
 *
 * Returns `false` when shift is null, day is off, or we're outside the
 * nudge window.
 */
export function isInsideShiftStartWindow(input: {
  schedule: ShiftSchedule;
  bufferMin: number;
  now: Date;
}): boolean {
  const day = todaysSchedule(input.schedule, input.now);
  if (day === null) return false;
  const nowMin = input.now.getHours() * 60 + input.now.getMinutes();
  const startMin = hhmmToMin(day.start);
  const endMin = startMin + Math.max(0, input.bufferMin);
  return nowMin >= startMin && nowMin <= endMin;
}

/**
 * When is the next shift start, given `now`? Returns the epoch ms (in
 * local time) of the next start. Used by the agent to schedule a one-shot
 * timer so it doesn't poll. Returns null if every day in the schedule is
 * null (no shift configured for any weekday — unusual but possible).
 */
export function nextShiftStartMs(input: { schedule: ShiftSchedule; now: Date }): number | null {
  // Look forward up to 7 days.
  for (let offset = 0; offset < 7; offset++) {
    const candidate = new Date(input.now);
    candidate.setDate(candidate.getDate() + offset);
    const day = input.schedule[weekdayKey(candidate)];
    if (!day) continue;
    const startMin = hhmmToMin(day.start);
    const startsAt = new Date(candidate);
    startsAt.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
    // For today (offset 0), require start to be in the future or right now.
    if (offset === 0 && startsAt.getTime() < input.now.getTime()) continue;
    return startsAt.getTime();
  }
  return null;
}

/** Empty schedule (all days off) — useful default. */
export const EMPTY_SCHEDULE: ShiftSchedule = {
  mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
};

/** Common defaults — M-F 9:00-18:00. */
export const NINE_TO_SIX: ShiftSchedule = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: null,
  sun: null,
};
