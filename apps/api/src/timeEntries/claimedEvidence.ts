import { prisma } from '@grind/db';
import { logger } from '../logger';

/**
 * Evidence (screenshots, activity minutes) that names a time entry the server
 * does not have yet.
 *
 * An agent creates its entry locally and captures under that id at once; the
 * create reaches us through the agent's sync queue, and the evidence through
 * separate uploaders. When the queue stalls — a Windows beta.37 agent's did for
 * hours — every shot and minute names an entry we have never seen. Refusing
 * them made installed agents count the failures and write the evidence off, so
 * instead it is stored detached and remembers the id it claimed
 * (`claimedTimeEntryId`). When that entry is created for the same person,
 * {@link linkClaimedEvidence} attaches it. Only an entry that exists and
 * belongs to somebody else is out of scope.
 */

export type EntryClaim =
  /** The caller's own entry: attach directly. */
  | { kind: 'owned'; timeEntryId: string }
  /** Not on the server yet: store detached, remember the claim. */
  | { kind: 'claimed'; claimedTimeEntryId: string }
  /** Somebody else's entry: never attach, never claim. */
  | { kind: 'foreign' };

/** Classify the entry ids a batch of evidence names, for one person. */
export async function classifyEntryClaims(userId: string, entryIds: Iterable<string>): Promise<Map<string, EntryClaim>> {
  const ids = [...new Set(entryIds)];
  const out = new Map<string, EntryClaim>();
  if (ids.length === 0) return out;
  const rows = await prisma.timeEntry.findMany({
    where: { id: { in: ids } },
    select: { id: true, userId: true },
  });
  const ownerOf = new Map(rows.map((row) => [row.id, row.userId]));
  for (const id of ids) {
    const owner = ownerOf.get(id);
    if (owner === undefined) out.set(id, { kind: 'claimed', claimedTimeEntryId: id });
    else if (owner === userId) out.set(id, { kind: 'owned', timeEntryId: id });
    else out.set(id, { kind: 'foreign' });
  }
  return out;
}

/**
 * Activity minutes are captured while their entry runs, so a claimed minute is
 * never earlier than the entry's start. Bounding the search by it lets the
 * (userId, bucketStart) unique index find the rows — no index on the claim
 * column of the largest table. A day of slack absorbs agent clock skew.
 */
const SAMPLE_CLAIM_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * Attach everything that claimed `entry` before it existed. Call it once the
 * entry is committed — after, not inside, the creating transaction: evidence
 * ingest stores its claim and then looks for the entry, this looks for claims
 * after the entry is visible, so whichever side commits second sees the other.
 */
export async function linkClaimedEvidence(entry: {
  id: string;
  userId: string;
  startedAt: Date;
}): Promise<{ screenshots: number; samples: number }> {
  const [screenshots, samples] = await Promise.all([
    prisma.screenshot.updateMany({
      where: { claimedTimeEntryId: entry.id, userId: entry.userId },
      data: { timeEntryId: entry.id, claimedTimeEntryId: null },
    }),
    prisma.activitySample.updateMany({
      where: {
        userId: entry.userId,
        bucketStart: { gte: new Date(entry.startedAt.getTime() - SAMPLE_CLAIM_SLACK_MS) },
        claimedTimeEntryId: entry.id,
      },
      data: { timeEntryId: entry.id, claimedTimeEntryId: null },
    }),
  ]);
  if (screenshots.count > 0 || samples.count > 0) {
    logger.info(
      { userId: entry.userId, entryId: entry.id, screenshots: screenshots.count, samples: samples.count },
      'linked evidence that arrived before its time entry',
    );
  }
  return { screenshots: screenshots.count, samples: samples.count };
}

/**
 * The ingest side of the race in {@link linkClaimedEvidence}: after storing
 * claims, attach any whose entry was created in the meantime.
 */
export async function linkClaimsIfEntriesArrived(userId: string, claimedIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(claimedIds)];
  if (ids.length === 0) return;
  const arrived = await prisma.timeEntry.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true, userId: true, startedAt: true },
  });
  for (const entry of arrived) await linkClaimedEvidence(entry);
}
