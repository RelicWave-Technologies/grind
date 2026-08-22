import { prisma } from '@grind/db';

/**
 * Punch in / punch out as recorded by an external system, keyed by person and
 * business date.
 *
 * These are NOT derived from tracked activity. Timo knows when the first
 * segment of a day started; a punch knows when someone was recorded at the
 * door. Keeping them apart is the point — where they disagree is usually the
 * interesting part of an attendance question.
 */
export interface DayPunch {
  /** Minutes since local midnight, or null when that side was not recorded. */
  inMinute: number | null;
  outMinute: number | null;
}

export type PunchLookup = (userId: string, date: string) => DayPunch | null;

/**
 * Prisma hands back a `TIME` column as a Date whose date part is the epoch and
 * whose clock part is the stored value, read in UTC. There is no timezone to
 * apply — the column holds a clock reading, not an instant — so the UTC
 * accessors are the correct ones here, not a mistake.
 */
function minuteOfTimeColumn(value: Date | null): number | null {
  if (!value) return null;
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

/** `YYYY-MM-DD` for a `DATE` column, again read without timezone shifting. */
function dateKeyOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Load the punches for a set of people over a date range into a lookup. Returns
 * null for a person-day with no row, which the reports render as a dash rather
 * than inventing a time.
 */
export async function loadPunchLookup(input: {
  userIds: string[];
  from: string;
  to: string;
}): Promise<PunchLookup> {
  if (input.userIds.length === 0) return () => null;

  const rows = await prisma.attendancePunch.findMany({
    where: {
      userId: { in: input.userIds },
      date: { gte: new Date(`${input.from}T00:00:00Z`), lte: new Date(`${input.to}T00:00:00Z`) },
    },
    select: { userId: true, date: true, punchInAt: true, punchOutAt: true },
  });

  const byUser = new Map<string, Map<string, DayPunch>>();
  for (const row of rows) {
    let perUser = byUser.get(row.userId);
    if (!perUser) {
      perUser = new Map();
      byUser.set(row.userId, perUser);
    }
    perUser.set(dateKeyOf(row.date), {
      inMinute: minuteOfTimeColumn(row.punchInAt),
      outMinute: minuteOfTimeColumn(row.punchOutAt),
    });
  }

  return (userId, date) => byUser.get(userId)?.get(date) ?? null;
}
