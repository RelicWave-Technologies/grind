import { prisma } from '@grind/db';

/** Email domain → unit name. The two companies sign in with their own domains. */
export const UNIT_BY_EMAIL_DOMAIN: Readonly<Record<string, string>> = {
  'emiactech.com': 'EMIAC',
  'macobstech.com': 'MACOBS',
};

export function unitNameForEmail(email: string): string | null {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  return UNIT_BY_EMAIL_DOMAIN[domain] ?? null;
}

export interface UnitBackfillReport {
  apply: boolean;
  /** Unit name → people given it (or who would be, on a dry run). */
  assigned: Record<string, Array<{ id: string; email: string; name: string }>>;
  /** People with no unit whose domain names none — set by hand on People. */
  unmatched: Array<{ id: string; email: string; name: string }>;
}

/**
 * Give everyone without a unit the one their email domain names. Only fills
 * blanks — a unit an admin already set is never changed. Dry run unless
 * `apply`; suspended people are included, since their past months still print.
 */
export async function backfillUnitsByEmail(input: { workspaceId: string; apply: boolean }): Promise<UnitBackfillReport> {
  const [units, people] = await Promise.all([
    prisma.unit.findMany({ where: { workspaceId: input.workspaceId }, select: { id: true, name: true } }),
    prisma.user.findMany({
      where: { workspaceId: input.workspaceId, unitId: null },
      select: { id: true, email: true, name: true },
      orderBy: { email: 'asc' },
    }),
  ]);
  const unitIdOf = new Map(units.map((u) => [u.name, u.id]));
  const report: UnitBackfillReport = { apply: input.apply, assigned: {}, unmatched: [] };
  for (const person of people) {
    const name = unitNameForEmail(person.email);
    const unitId = name ? unitIdOf.get(name) : undefined;
    if (!name || !unitId) {
      report.unmatched.push(person);
      continue;
    }
    (report.assigned[name] ??= []).push(person);
  }
  if (input.apply) {
    for (const [name, list] of Object.entries(report.assigned)) {
      await prisma.user.updateMany({
        // unitId: null again, so a unit set between the read and now survives.
        where: { id: { in: list.map((p) => p.id) }, unitId: null },
        data: { unitId: unitIdOf.get(name)! },
      });
    }
  }
  return report;
}
