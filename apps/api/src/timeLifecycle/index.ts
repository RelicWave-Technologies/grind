import { prisma, type Prisma, type TimeEntryCloseReason } from '@grind/db';
import type { TimerCheckpoint, TimerCheckpointDisposition } from '@grind/types';
import { logger } from '../logger';
import { START_TIME_MS } from '../lib/version';
import { onShutdown } from '../lib/lifecycle';

export const TIMER_PROTOCOL_VERSION = 2;
export const TIMER_LEASE_MS = 3 * 60 * 1000;
const TIMER_RECONCILE_INTERVAL_MS = 60 * 1000;
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

  if (entry.trackingProtocolVersion !== TIMER_PROTOCOL_VERSION) {
    return {
      disposition: 'needs_sync',
      entryId: entry.id,
      serverRevision: entry.agentRevision,
      endedAt: null,
      closeReason: null,
    };
  }

  // A heartbeat proves the agent is alive and still on this entry, whatever
  // revision it has reached. Renewing only on an exact revision match let one
  // lost PUT lapse the lease under a running timer, and reports then cut the
  // entry at lastProvenAt — a gap in the middle of real work. Liveness renews
  // here; a revision mismatch still asks the agent to push its data.
  const revisionMatches = entry.agentRevision === checkpoint.revision;
  const checkpointAt = clampCheckpointAt(checkpoint.observedAt, now, entry.startedAt);
  const lastProvenAt = entry.lastProvenAt && entry.lastProvenAt > checkpointAt
    ? entry.lastProvenAt
    : checkpointAt;
  const renewed = await tx.timeEntry.updateMany({
    where: {
      id: entry.id,
      endedAt: null,
      trackingProtocolVersion: TIMER_PROTOCOL_VERSION,
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
    disposition: revisionMatches ? 'accepted' : 'needs_sync',
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
  // An open segment that would close at its own start carried no time; it is
  // removed, never stored as a zero-length span (ZERO-LENGTH SEGMENTS, core).
  await tx.timeSegment.deleteMany({
    where: { timeEntryId: row.id, endedAt: null, startedAt: { gte: closeAt } },
  });
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
  // Up to a hundred rows, a few statements each: under load that outlives
  // Prisma's 5s default, and a timed-out batch rolls back every row in it.
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
  }, { timeout: 30_000 });
}

let schedulerStarted = false;

/** When the reconciler last reached the database, and when it last came back from not reaching it. */
export interface ReconcileClock {
  resumedAtMs: number;
  lastOkAtMs: number | null;
}

/**
 * May this tick finalize expired leases?
 *
 * Only once the API has been able to hear agents for a full lease length. A
 * deploy, a database outage or an overload that timed every heartbeat out all
 * leave leases ticking down while no agent could renew them; sweeping the
 * moment we come back would close every running timer for an outage that was
 * ours. So a start (resumedAtMs = process start) or a gap of more than one
 * lease since the last tick that reached the database restarts the wait. One
 * lease length is exactly the time a live agent needs to checkpoint again.
 */
export function reconcileGate(nowMs: number, clock: ReconcileClock): { finalize: boolean; resumedAtMs: number } {
  const wasBlind = clock.lastOkAtMs !== null && nowMs - clock.lastOkAtMs > TIMER_LEASE_MS;
  const resumedAtMs = wasBlind ? nowMs : clock.resumedAtMs;
  return { finalize: nowMs - resumedAtMs >= TIMER_LEASE_MS, resumedAtMs };
}

export function startTimerLifecycleScheduler(enabled: boolean): void {
  if (!enabled || schedulerStarted) return;
  schedulerStarted = true;
  let active = false;
  const clock: ReconcileClock = { resumedAtMs: START_TIME_MS, lastOkAtMs: null };
  const tick = async () => {
    if (active) return;
    active = true;
    try {
      const now = Date.now();
      const gate = reconcileGate(now, clock);
      if (gate.resumedAtMs !== clock.resumedAtMs) {
        logger.warn({ lastOkAt: new Date(clock.lastOkAtMs!).toISOString() }, 'timer reconciler was blind for over a lease; holding off');
      }
      clock.resumedAtMs = gate.resumedAtMs;
      if (gate.finalize) {
        const finalized = await reconcileExpiredTimersOnce(new Date(now));
        if (finalized > 0) logger.warn({ finalized }, 'expired timer leases finalized');
      } else {
        // Waiting out the grace still has to notice the database is back.
        await prisma.$queryRaw`SELECT 1`;
      }
      clock.lastOkAtMs = now;
    } catch (err) {
      logger.error({ err: String(err) }, 'timer lifecycle reconciliation failed');
    } finally {
      active = false;
    }
  };
  const handle = setInterval(() => void tick(), TIMER_RECONCILE_INTERVAL_MS);
  handle.unref?.();
  const first = setTimeout(() => void tick(), TIMER_RECONCILE_INTERVAL_MS);
  first.unref?.();
  onShutdown(() => {
    clearInterval(handle);
    clearTimeout(first);
  });
}
