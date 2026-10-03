import { prisma, type Prisma } from '@grind/db';
import { ATTENDANCE_RULE_LABEL, roundToHalfDay, type AttendanceRuleVerdict } from '@grind/types';

type Tx = Prisma.TransactionClient;

/**
 * The balance side of the attendance rules.
 *
 * A day a rule charged is leave, and leave draws on the paid-leave balance. So
 * each charged day gets one ledger line, keyed by person and date, holding the
 * days the rule took. The line follows the verdict: when time syncs late, an
 * approval lands in Lark, or a manager corrects the day, the next reconcile
 * rewrites or removes it. Nothing is ever charged twice for one day, because
 * the key is unique.
 *
 * CONSUMPTION, so the funding walk leaves it out of the credits it spends. The
 * walk prices the day itself, from this same line — see `loadWorkingCalendar`.
 */

export const RULE_SOURCE_PREFIX = 'rule:';

export function ruleLedgerSourceKey(userId: string, date: string): string {
  return `${RULE_SOURCE_PREFIX}${userId}:${date}`;
}

/** userId|date -> verdict, for the days a rule charged. */
export type RuleVerdicts = Map<string, AttendanceRuleVerdict>;

export function verdictKey(userId: string, date: string): string {
  return `${userId}|${date}`;
}

/**
 * Make the ledger say what the verdicts say, for these people over [from, to].
 *
 * Writes only the difference: an unchanged line is left alone, so a report that
 * reconciles on every load does not churn the table. Returns how many lines
 * changed, which is what tells a caller its calendar has to be reloaded.
 */
export async function reconcileRuleLedger(input: {
  workspaceId: string;
  userIds: string[];
  from: string;
  to: string;
  verdicts: RuleVerdicts;
  db?: Tx | typeof prisma;
}): Promise<{ written: number; removed: number }> {
  const db = input.db ?? prisma;
  if (input.userIds.length === 0) return { written: 0, removed: 0 };

  const existing = await db.leaveLedgerEntry.findMany({
    where: {
      userId: { in: input.userIds },
      sourceKey: { startsWith: RULE_SOURCE_PREFIX },
      effectiveOn: { gte: new Date(`${input.from}T00:00:00Z`), lte: new Date(`${input.to}T00:00:00Z`) },
    },
    select: { id: true, userId: true, effectiveOn: true, days: true, reason: true },
  });

  const existingByKey = new Map(
    existing.map((e) => [verdictKey(e.userId, e.effectiveOn.toISOString().slice(0, 10)), e]),
  );

  const stale = existing.filter(
    (e) => !input.verdicts.has(verdictKey(e.userId, e.effectiveOn.toISOString().slice(0, 10))),
  );
  if (stale.length > 0) {
    await db.leaveLedgerEntry.deleteMany({ where: { id: { in: stale.map((e) => e.id) } } });
  }

  let written = 0;
  for (const [key, verdict] of input.verdicts) {
    const [userId, date] = key.split('|') as [string, string];
    if (date < input.from || date > input.to) continue;
    const days = roundToHalfDay(-verdict.penaltyDays);
    const reason = ATTENDANCE_RULE_LABEL[verdict.tag];
    const current = existingByKey.get(key);
    if (current && current.days === days && current.reason === reason) continue;

    await db.leaveLedgerEntry.upsert({
      where: { sourceKey: ruleLedgerSourceKey(userId, date) },
      update: { days, reason },
      create: {
        workspaceId: input.workspaceId,
        userId,
        kind: 'CONSUMPTION',
        days,
        effectiveOn: new Date(`${date}T00:00:00Z`),
        sourceKey: ruleLedgerSourceKey(userId, date),
        reason,
      },
    });
    written += 1;
  }

  return { written, removed: stale.length };
}
