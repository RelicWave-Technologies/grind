import { prisma, type Prisma } from '@grind/db';
import { attendanceOverrideShape, roundToHalfDay, type AttendanceOverrideCode } from '@grind/types';

type Tx = Prisma.TransactionClient;

/**
 * The balance side of a manager's correction.
 *
 * A correction is a claim on the same balance an approved leave is a claim on,
 * so it has to reach the ledger — otherwise the report says a day cost half a
 * day while the statement says it cost nothing, and both are on screen at once.
 *
 * What gets written is the *difference*, not the charge: Lark has usually
 * already billed the day, and a correction is an argument with that bill rather
 * than a second one. Told a day was Present, the entry hands back what Lark
 * took. Told a day was half a day of leave when nobody had filed any, it takes
 * half a day. Told the same thing Lark already said, it writes nothing at all,
 * because nothing changed.
 *
 * One row per corrected person-day, keyed so that re-deciding a day replaces
 * its entry instead of stacking a second one nobody could order.
 */
export function overrideLedgerSourceKey(userId: string, date: string): string {
  return `override:${userId}:${date}`;
}

/** What a correction says the day costs a balance. */
export function overrideDayCost(code: AttendanceOverrideCode, chargeableDay: boolean): number {
  if (!chargeableDay) return 0;
  switch (attendanceOverrideShape(code)) {
    case 'FULL_LEAVE': return 1;
    case 'HALF_LEAVE': return 0.5;
    // Present or absent costs a balance nothing, whatever Lark recorded.
    default: return 0;
  }
}

/**
 * Write, replace or drop the entry that reconciles one corrected day.
 *
 * `alreadyCharged` is what the leave data by itself billed for this date — the
 * calendar's own answer for the day, with no correction applied. `nowCosts` is
 * what the correction says it should be, or null when the correction has been
 * taken back and the day returns to the leave data.
 */
export async function reconcileOverrideLedger(input: {
  workspaceId: string;
  userId: string;
  date: string;
  alreadyCharged: number;
  nowCosts: number | null;
  createdById: string;
  db?: Tx | typeof prisma;
}): Promise<number> {
  const db = input.db ?? prisma;
  const sourceKey = overrideLedgerSourceKey(input.userId, input.date);

  // A cleared correction leaves nothing behind: the leave data is charging the
  // day again on its own, and a lingering entry would double it.
  if (input.nowCosts === null) {
    await db.leaveLedgerEntry.deleteMany({ where: { sourceKey } });
    return 0;
  }

  // Signed the way the ledger signs everything: consumption is negative.
  const delta = roundToHalfDay(input.alreadyCharged - input.nowCosts);
  if (delta === 0) {
    await db.leaveLedgerEntry.deleteMany({ where: { sourceKey } });
    return 0;
  }

  const reason = delta < 0
    ? `Corrected by hand — ${input.date} costs ${input.nowCosts} day${input.nowCosts === 1 ? '' : 's'}`
    : `Corrected by hand — ${input.date} returned ${delta} day${delta === 1 ? '' : 's'}`;

  await db.leaveLedgerEntry.upsert({
    where: { sourceKey },
    update: { days: delta, reason, createdById: input.createdById },
    create: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      // ADJUSTMENT rather than CONSUMPTION even when it takes days away: this is
      // somebody overruling the record, not leave being filed, and a statement
      // that called it consumption would leave no trace of who disagreed.
      kind: 'ADJUSTMENT',
      days: delta,
      effectiveOn: new Date(`${input.date}T00:00:00Z`),
      sourceKey,
      reason,
      createdById: input.createdById,
    },
  });
  return delta;
}
