import { prisma, type Prisma, type TimeEntryCloseReason } from '@grind/db';
import type { TimerCheckpoint, TimerCheckpointDisposition } from '@grind/types';
import { logger } from '../logger';

export const TIMER_PROTOCOL_VERSION = 2;
export const TIMER_LEASE_MS = 3 * 60 * 1000;
export const TIMER_RECONCILE_INTERVAL_MS = 60 * 1000;
const RECONCILE_BATCH_SIZE = 100;

type Tx = Prisma.TransactionClient;

/** Serialize ownership changes even when the user has no open row to lock. */
export async function lockTimerOwner(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_advisory_xact_lock(hashtextextended(${'timo-timer:' + userId}, 0)) IS NULL AS "locked"
  `;
}

export interface TimerCheckpointResult {
  disposition: TimerCheckpointDisposition;
  entryId: string;
  serverRevision: number | null;
  endedAt: string | null;
  closeReason: TimeEntryCloseReason | null;
}

function clampCheckpointAt(observedAt: string, now: Date, startedAt: Date): Date {
  const observedMs = new Date(observedAt).getTime();
  const bounded = Number.isFinite(observedMs) ? Math.min(observedMs, now.getTime()) : now.getTime();
  return new Date(Math.max(startedAt.getTime(), bounded));
}

export async function renewTimerLease(
  tx: Tx,
  userId: string,
  checkpoint: TimerCheckpoint,
  now: Date,
): Promise<TimerCheckpointResult> {
  const entry = await tx.timeEntry.findUnique({
    where: { id: checkpoint.entryId },
    select: {
      id: true,
      userId: true,
      startedAt: true,
      endedAt: true,
      closeReason: true,
      agentRevision: true,
      trackingProtocolVersion: true,
      lastProvenAt: true,
    },
  });

  if (!entry || entry.userId !== userId) {
    return {
      disposition: 'needs_sync',
      entryId: checkpoint.entryId,
      serverRevision: null,
      endedAt: null,
      closeReason: null,
    };
  }

  if (entry.endedAt) {
    const observedAt = clampCheckpointAt(checkpoint.observedAt, now, entry.startedAt);
    const mayReconcile = entry.closeReason === 'LEASE_EXPIRED' && observedAt > entry.endedAt;
    const newerActive = mayReconcile
      ? await tx.timeEntry.findFirst({
          where: {
            id: { not: entry.id },
            userId,
            source: 'AUTO',
            endedAt: null,
            trackingProtocolVersion: TIMER_PROTOCOL_VERSION,
          },
          select: { id: true },
        })
      : null;
    return {
      disposition: newerActive ? 'conflict' : mayReconcile ? 'needs_sync' : 'finalized',
      entryId: entry.id,
      serverRevision: entry.agentRevision,
      endedAt: entry.endedAt.toISOString(),
      closeReason: entry.closeReason,
    };
  }

  if (entry.trackingProtocolVersion !== TIMER_PROTOCOL_VERSION || entry.agentRevision !== checkpoint.revision) {
    return {
      disposition: 'needs_sync',
      entryId: entry.id,
      serverRevision: entry.agentRevision,
      endedAt: null,
      closeReason: null,
    };
  }

  const checkpointAt = clampCheckpointAt(checkpoint.observedAt, now, entry.startedAt);
  const lastProvenAt = entry.lastProvenAt && entry.lastProvenAt > checkpointAt
    ? entry.lastProvenAt
    : checkpointAt;
  const renewed = await tx.timeEntry.updateMany({
    where: {
      id: entry.id,
      endedAt: null,
      trackingProtocolVersion: TIMER_PROTOCOL_VERSION,
      agentRevision: checkpoint.revision,
    },
    data: {
      lastProvenAt,
      leaseExpiresAt: new Date(now.getTime() + TIMER_LEASE_MS),
    },
  });

  if (renewed.count === 0) {
    const latest = await tx.timeEntry.findUnique({
      where: { id: entry.id },
      select: { endedAt: true, closeReason: true, agentRevision: true },
    });
    return {
      disposition: latest?.endedAt ? 'finalized' : 'needs_sync',
      entryId: entry.id,
      serverRevision: latest?.agentRevision ?? null,
      endedAt: latest?.endedAt?.toISOString() ?? null,
      closeReason: latest?.closeReason ?? null,
    };
  }

  return {
    disposition: 'accepted',
    entryId: entry.id,
    serverRevision: entry.agentRevision,
    endedAt: null,
    closeReason: null,
  };
}

interface LockedExpiredEntry {
  id: string;
  userId: string;
  startedAt: Date;
  lastProvenAt: Date | null;
  leaseExpiresAt?: Date | null;
}

async function finalizeLockedEntry(
  tx: Tx,
  row: LockedExpiredEntry,
  closeReason: Extract<TimeEntryCloseReason, 'LEASE_EXPIRED' | 'SUPERSEDED'>,
  now: Date,
): Promise<boolean> {
  const segments = await tx.timeSegment.findMany({
    where: { timeEntryId: row.id },
    select: { id: true, startedAt: true, endedAt: true },
    orderBy: { startedAt: 'asc' },
  });
  const latestBoundaryMs = segments.reduce(
    (max, segment) => Math.max(max, segment.startedAt.getTime(), segment.endedAt?.getTime() ?? 0),
    row.startedAt.getTime(),
  );
  const closeAt = new Date(Math.max(row.lastProvenAt?.getTime() ?? 0, latestBoundaryMs));
  await tx.timeSegment.updateMany({
    where: { timeEntryId: row.id, endedAt: null },
    data: { endedAt: closeAt },
  });
  const updated = await tx.timeEntry.updateMany({
    where: { id: row.id, endedAt: null },
    data: {
      endedAt: closeAt,
      closeReason,
      serverFinalizedAt: now,
      leaseExpiresAt: null,
    },
  });
  if (updated.count !== 1) return false;

  await tx.user.updateMany({
    where: { id: row.userId, agentActiveEntryId: row.id },
    data: { agentActiveEntryId: null },
  });
  return true;
}

/** Close expired ownership before allowing a new protocol-v2 timer. */
export async function supersedeExpiredTimersForUser(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<string | null> {
  await lockTimerOwner(tx, userId);
  const rows = await tx.$queryRaw<LockedExpiredEntry[]>`
    SELECT "id", "userId", "startedAt", "lastProvenAt", "leaseExpiresAt"
    FROM "TimeEntry"
    WHERE "userId" = ${userId}
      AND "source" = 'AUTO'::"TimeEntrySource"
      AND "trackingProtocolVersion" = ${TIMER_PROTOCOL_VERSION}
      AND "endedAt" IS NULL
    ORDER BY "startedAt" DESC
    FOR UPDATE
  `;
  const active = rows.find((row) => row.leaseExpiresAt && row.leaseExpiresAt > now);
  if (active) return active.id;
  for (const row of rows) await finalizeLockedEntry(tx, row, 'SUPERSEDED', now);
  return null;
}

/** Finalize one bounded, multi-instance-safe batch of expired leases. */
export async function reconcileExpiredTimersOnce(now = new Date()): Promise<number> {
  const utcNow = now.toISOString();
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedExpiredEntry[]>`
      SELECT "id", "userId", "startedAt", "lastProvenAt"
      FROM "TimeEntry"
      WHERE "trackingProtocolVersion" = ${TIMER_PROTOCOL_VERSION}
        AND "endedAt" IS NULL
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" <= (${utcNow}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "leaseExpiresAt" ASC
      LIMIT ${RECONCILE_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;

    let finalized = 0;
    for (const row of rows) {
      if (await finalizeLockedEntry(tx, row, 'LEASE_EXPIRED', now)) finalized += 1;
    }
    return finalized;
  });
}

let schedulerStarted = false;

export function startTimerLifecycleScheduler(enabled: boolean): void {
  if (!enabled || schedulerStarted) return;
  schedulerStarted = true;
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try {
      const finalized = await reconcileExpiredTimersOnce();
      if (finalized > 0) logger.warn({ finalized }, 'expired timer leases finalized');
    } catch (err) {
      logger.error({ err: String(err) }, 'timer lifecycle reconciliation failed');
    } finally {
      active = false;
    }
  };
  const handle = setInterval(() => void tick(), TIMER_RECONCILE_INTERVAL_MS);
  handle.unref?.();
  setTimeout(() => void tick(), TIMER_RECONCILE_INTERVAL_MS).unref?.();
}
