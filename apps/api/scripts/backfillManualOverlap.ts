/**
 * Backfill: trim stored manual time that overlaps tracked time.
 *
 * The read path now resolves overlaps, so reported totals are already correct.
 * This cleans the rows underneath, which matters for three things the read path
 * cannot help with: raw exports, anything written against segments in future,
 * and adding a database-level exclusion constraint (which will not apply while
 * overlapping rows exist).
 *
 * Same rule as everywhere else: observed time wins, manual keeps what is free,
 * trimmed idle never blocks a claim.
 *
 * REPORT BY DEFAULT. Pass --apply to write. Every user is handled in its own
 * transaction, so a failure part way leaves earlier users already correct and
 * the rest untouched — re-running finishes the job.
 *
 *   pnpm exec dotenv -e ../../.env -- tsx scripts/backfillManualOverlap.ts
 *   pnpm exec dotenv -e ../../.env -- tsx scripts/backfillManualOverlap.ts --apply
 */
import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import { freeSlices, type Span } from '../src/insights/overlap';

const APPLY = process.argv.includes('--apply');
const MIN = 60_000;

interface SegRow { id: string; timeEntryId: string; startedAt: Date; endedAt: Date | null }

interface Plan {
  userId: string;
  userName: string;
  /** Segments to delete outright — every minute already belongs to tracked time. */
  drop: SegRow[];
  /** Segments to replace with narrower pieces. */
  split: Array<{ seg: SegRow; slices: Span[] }>;
  reclaimedMs: number;
}

async function planForUser(userId: string, userName: string): Promise<Plan | null> {
  const segments = await prisma.timeSegment.findMany({
    where: { timeEntry: { userId } },
    select: {
      id: true, timeEntryId: true, startedAt: true, endedAt: true, kind: true,
      timeEntry: { select: { source: true } },
    },
    orderBy: { startedAt: 'asc' },
  });

  // Only closed segments can be reasoned about; an open one is a live timer.
  const closed = segments.filter((s) => s.endedAt !== null);
  const tracked: Span[] = closed
    .filter((s) => s.timeEntry.source !== 'MANUAL' && s.kind !== 'IDLE_TRIMMED')
    .map((s) => ({ startedAt: s.startedAt.getTime(), endedAt: s.endedAt!.getTime() }));
  const manual = closed.filter((s) => s.timeEntry.source === 'MANUAL');
  if (tracked.length === 0 || manual.length === 0) return null;

  const plan: Plan = { userId, userName, drop: [], split: [], reclaimedMs: 0 };
  // Manual segments also must not overlap each other, so each one that survives
  // joins the occupied set for the ones after it.
  const occupied = [...tracked];
  for (const s of manual) {
    const span = { startedAt: s.startedAt.getTime(), endedAt: s.endedAt!.getTime() };
    const slices = freeSlices(span, occupied);
    const originalMs = span.endedAt - span.startedAt;
    const keptMs = slices.reduce((sum, x) => sum + (x.endedAt - x.startedAt), 0);
    if (keptMs === originalMs) {
      occupied.push(span);
      continue; // untouched
    }
    plan.reclaimedMs += originalMs - keptMs;
    if (slices.length === 0) plan.drop.push(s);
    else plan.split.push({ seg: s, slices });
    occupied.push(...slices);
  }
  return plan.drop.length || plan.split.length ? plan : null;
}

async function applyPlan(plan: Plan): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const s of plan.drop) {
      await tx.timeSegment.delete({ where: { id: s.id } });
    }
    for (const { seg, slices } of plan.split) {
      const [first, ...rest] = slices;
      await tx.timeSegment.update({
        where: { id: seg.id },
        data: { startedAt: new Date(first!.startedAt), endedAt: new Date(first!.endedAt) },
      });
      for (const extra of rest) {
        await tx.timeSegment.create({
          data: {
            id: ulid(),
            timeEntryId: seg.timeEntryId,
            kind: 'WORK',
            startedAt: new Date(extra.startedAt),
            endedAt: new Date(extra.endedAt),
          },
        });
      }
    }

    // Re-anchor every touched entry to whatever segments it has left, and drop
    // entries that no longer represent any time at all.
    const touched = [...new Set([
      ...plan.drop.map((s) => s.timeEntryId),
      ...plan.split.map((x) => x.seg.timeEntryId),
    ])];
    for (const entryId of touched) {
      const left = await tx.timeSegment.findMany({
        where: { timeEntryId: entryId },
        select: { startedAt: true, endedAt: true },
        orderBy: { startedAt: 'asc' },
      });
      if (left.length === 0) {
        await tx.manualTimeRequest.updateMany({ where: { timeEntryId: entryId }, data: { timeEntryId: null } });
        await tx.timeEntry.delete({ where: { id: entryId } });
        continue;
      }
      await tx.timeEntry.update({
        where: { id: entryId },
        data: {
          startedAt: left[0]!.startedAt,
          endedAt: left[left.length - 1]!.endedAt,
        },
      });
    }
  });
}

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, name: true, email: true } });
  const plans: Plan[] = [];
  for (const u of users) {
    const p = await planForUser(u.id, u.name || u.email);
    if (p) plans.push(p);
  }

  if (plans.length === 0) {
    console.log('No manual time overlaps tracked time. Nothing to do.');
    return;
  }

  const totalMs = plans.reduce((s, p) => s + p.reclaimedMs, 0);
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${plans.length} user(s) affected, `
    + `${Math.round(totalMs / MIN)} minutes of double-counted manual time\n`);
  for (const p of plans) {
    console.log(`  ${p.userName}`);
    console.log(`    segments removed : ${p.drop.length}`);
    console.log(`    segments trimmed : ${p.split.length}`);
    console.log(`    minutes reclaimed: ${Math.round(p.reclaimedMs / MIN)}`);
  }

  if (!APPLY) {
    console.log('\nNothing written. Re-run with --apply to make these changes.');
    return;
  }
  for (const p of plans) await applyPlan(p);
  console.log('\nDone.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
