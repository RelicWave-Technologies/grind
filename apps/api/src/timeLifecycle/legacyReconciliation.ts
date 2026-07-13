import { createHash } from 'node:crypto';
import { prisma } from '@grind/db';

const ACTIVITY_SAMPLE_MS = 60_000;
export const DEFAULT_LEGACY_STALE_MINUTES = 15;

type PlanDb = Pick<typeof prisma, 'timeEntry' | 'user'>;

export interface LegacyReconciliationEntry {
  entryId: string;
  userId: string;
  userName: string;
  userEmail: string;
  startedAt: string;
  proposedEndedAt: string;
  latestActivitySampleAt: string | null;
  latestScreenshotAt: string | null;
  latestRunningHeartbeatAt: string | null;
  latestClosedSegmentEnd: string | null;
  openSegmentCount: number;
  unsafeDurationMs: number;
  reconciledDurationMs: number;
}

export interface LegacyReconciliationSkip {
  entryId: string;
  userId: string;
  reason: 'FRESH_HEARTBEAT' | 'FUTURE_EVIDENCE';
}

export interface LegacyPointerRepair {
  userId: string;
  userName: string;
  userEmail: string;
  staleEntryId: string;
  reason: 'CLOSED_ENTRY' | 'MISSING_ENTRY';
  staleEntryEndedAt: string | null;
}

export interface LegacyReconciliationPlan {
  version: 4;
  generatedAt: string;
  staleMinutes: number;
  planHash: string;
  entries: LegacyReconciliationEntry[];
  pointerRepairs: LegacyPointerRepair[];
  skipped: LegacyReconciliationSkip[];
  totals: {
    candidates: number;
    pointerRepairs: number;
    skipped: number;
    unsafeDurationMs: number;
    reconciledDurationMs: number;
    removedUnprovenMs: number;
  };
}

function durationMs(
  segments: Array<{ kind: string; startedAt: Date; endedAt: Date | null }>,
  openEnd: Date,
): number {
  return segments.reduce((sum, segment) => {
    if (segment.kind === 'IDLE_TRIMMED') return sum;
    const end = segment.endedAt ?? openEnd;
    return sum + Math.max(0, end.getTime() - segment.startedAt.getTime());
  }, 0);
}

function hashPlan(
  staleMinutes: number,
  entries: LegacyReconciliationEntry[],
  pointerRepairs: LegacyPointerRepair[],
): string {
  const stable = {
    version: 4,
    staleMinutes,
    entries: entries.map((entry) => ({
      entryId: entry.entryId,
      userId: entry.userId,
      startedAt: entry.startedAt,
      proposedEndedAt: entry.proposedEndedAt,
      latestActivitySampleAt: entry.latestActivitySampleAt,
      latestScreenshotAt: entry.latestScreenshotAt,
      latestRunningHeartbeatAt: entry.latestRunningHeartbeatAt,
      latestClosedSegmentEnd: entry.latestClosedSegmentEnd,
      openSegmentCount: entry.openSegmentCount,
      reconciledDurationMs: entry.reconciledDurationMs,
    })),
    pointerRepairs: pointerRepairs.map((repair) => ({
      userId: repair.userId,
      staleEntryId: repair.staleEntryId,
      reason: repair.reason,
      staleEntryEndedAt: repair.staleEntryEndedAt,
    })),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export async function buildLegacyReconciliationPlan(args: {
  now?: Date;
  staleMinutes?: number;
  db?: PlanDb;
} = {}): Promise<LegacyReconciliationPlan> {
  const now = args.now ?? new Date();
  const staleMinutes = args.staleMinutes ?? DEFAULT_LEGACY_STALE_MINUTES;
  if (!Number.isInteger(staleMinutes) || staleMinutes < 5) {
    throw new Error('stale_minutes_must_be_an_integer_at_least_5');
  }
  const staleBefore = new Date(now.getTime() - staleMinutes * 60_000);
  const db = args.db ?? prisma;
  const rows = await db.timeEntry.findMany({
    where: {
      source: 'AUTO',
      endedAt: null,
      trackingProtocolVersion: null,
    },
    select: {
      id: true,
      userId: true,
      startedAt: true,
      user: {
        select: {
          name: true,
          email: true,
          agentLastSeenAt: true,
          agentState: true,
          agentActiveEntryId: true,
        },
      },
      segments: {
        select: { kind: true, startedAt: true, endedAt: true },
        orderBy: { startedAt: 'asc' },
      },
      activitySamples: {
        select: { bucketStart: true },
        orderBy: { bucketStart: 'desc' },
        take: 1,
      },
      screenshots: {
        select: { capturedAt: true },
        orderBy: { capturedAt: 'desc' },
        take: 1,
      },
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });

  const entries: LegacyReconciliationEntry[] = [];
  const skipped: LegacyReconciliationSkip[] = [];
  for (const row of rows) {
    if (row.user.agentLastSeenAt && row.user.agentLastSeenAt >= staleBefore) {
      skipped.push({ entryId: row.id, userId: row.userId, reason: 'FRESH_HEARTBEAT' });
      continue;
    }

    const latestSampleAt = row.activitySamples[0]?.bucketStart ?? null;
    const latestSampleEndMs = latestSampleAt ? latestSampleAt.getTime() + ACTIVITY_SAMPLE_MS : 0;
    const latestScreenshotAt = row.screenshots[0]?.capturedAt ?? null;
    const latestRunningHeartbeatAt = row.user.agentState === 'RUNNING'
      && row.user.agentActiveEntryId === row.id
      ? row.user.agentLastSeenAt
      : null;
    const latestClosedSegmentEnd = row.segments.reduce<Date | null>((latest, segment) => {
      if (!segment.endedAt || (latest && latest >= segment.endedAt)) return latest;
      return segment.endedAt;
    }, null);
    const latestSegmentStartMs = row.segments.reduce(
      (latest, segment) => Math.max(latest, segment.startedAt.getTime()),
      row.startedAt.getTime(),
    );
    const latestEvidenceMs = Math.max(
      row.startedAt.getTime(),
      latestSegmentStartMs,
      latestClosedSegmentEnd?.getTime() ?? 0,
      latestSampleEndMs,
      latestScreenshotAt?.getTime() ?? 0,
      latestRunningHeartbeatAt?.getTime() ?? 0,
    );
    if (latestEvidenceMs > now.getTime()) {
      skipped.push({ entryId: row.id, userId: row.userId, reason: 'FUTURE_EVIDENCE' });
      continue;
    }

    const proposedEndedAt = new Date(latestEvidenceMs);
    entries.push({
      entryId: row.id,
      userId: row.userId,
      userName: row.user.name,
      userEmail: row.user.email,
      startedAt: row.startedAt.toISOString(),
      proposedEndedAt: proposedEndedAt.toISOString(),
      latestActivitySampleAt: latestSampleAt?.toISOString() ?? null,
      latestScreenshotAt: latestScreenshotAt?.toISOString() ?? null,
      latestRunningHeartbeatAt: latestRunningHeartbeatAt?.toISOString() ?? null,
      latestClosedSegmentEnd: latestClosedSegmentEnd?.toISOString() ?? null,
      openSegmentCount: row.segments.filter((segment) => segment.endedAt === null).length,
      unsafeDurationMs: durationMs(row.segments, now),
      reconciledDurationMs: durationMs(row.segments, proposedEndedAt),
    });
  }

  const pointerUsers = await db.user.findMany({
    where: { agentActiveEntryId: { not: null } },
    select: { id: true, name: true, email: true, agentActiveEntryId: true },
    orderBy: { id: 'asc' },
  });
  const pointerEntryIds = [...new Set(pointerUsers.flatMap((user) => user.agentActiveEntryId ?? []))];
  const pointerEntries = pointerEntryIds.length
    ? await db.timeEntry.findMany({
        where: { id: { in: pointerEntryIds } },
        select: { id: true, endedAt: true },
      })
    : [];
  const pointerEntryById = new Map(pointerEntries.map((entry) => [entry.id, entry]));
  const pointerRepairs: LegacyPointerRepair[] = pointerUsers.flatMap((user) => {
    const staleEntryId = user.agentActiveEntryId;
    if (!staleEntryId) return [];
    const entry = pointerEntryById.get(staleEntryId);
    if (entry && entry.endedAt === null) return [];
    return [{
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      staleEntryId,
      reason: entry ? 'CLOSED_ENTRY' as const : 'MISSING_ENTRY' as const,
      staleEntryEndedAt: entry?.endedAt?.toISOString() ?? null,
    }];
  });

  const unsafeDurationMs = entries.reduce((sum, entry) => sum + entry.unsafeDurationMs, 0);
  const reconciledDurationMs = entries.reduce((sum, entry) => sum + entry.reconciledDurationMs, 0);
  return {
    version: 4,
    generatedAt: now.toISOString(),
    staleMinutes,
    planHash: hashPlan(staleMinutes, entries, pointerRepairs),
    entries,
    pointerRepairs,
    skipped,
    totals: {
      candidates: entries.length,
      pointerRepairs: pointerRepairs.length,
      skipped: skipped.length,
      unsafeDurationMs,
      reconciledDurationMs,
      removedUnprovenMs: Math.max(0, unsafeDurationMs - reconciledDurationMs),
    },
  };
}

export async function applyLegacyReconciliationPlan(args: {
  planHash: string;
  staleMinutes?: number;
  now?: Date;
}): Promise<{ applied: number; repairedPointers: number; planHash: string }> {
  if (!/^[a-f0-9]{64}$/u.test(args.planHash)) throw new Error('valid_plan_hash_required');
  const now = args.now ?? new Date();
  const preview = await buildLegacyReconciliationPlan({ now, staleMinutes: args.staleMinutes });
  if (preview.planHash !== args.planHash) throw new Error('legacy_reconciliation_plan_changed');
  if (preview.entries.length === 0 && preview.pointerRepairs.length === 0) {
    return { applied: 0, repairedPointers: 0, planHash: preview.planHash };
  }

  return prisma.$transaction(async (tx) => {
    const entryIds = [...new Set([
      ...preview.entries.map((entry) => entry.entryId),
      ...preview.pointerRepairs
        .filter((repair) => repair.reason === 'CLOSED_ENTRY')
        .map((repair) => repair.staleEntryId),
    ])];
    const userIds = [...new Set([
      ...preview.entries.map((entry) => entry.userId),
      ...preview.pointerRepairs.map((repair) => repair.userId),
    ])];
    for (const entryId of entryIds.sort()) {
      await tx.$queryRaw`SELECT "id" FROM "TimeEntry" WHERE "id" = ${entryId} FOR UPDATE`;
    }
    for (const userId of userIds.sort()) {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    }

    const lockedPlan = await buildLegacyReconciliationPlan({
      now,
      staleMinutes: preview.staleMinutes,
      db: tx,
    });
    if (lockedPlan.planHash !== args.planHash) throw new Error('legacy_reconciliation_plan_changed');

    for (const entry of lockedPlan.entries) {
      const proposedEndedAt = new Date(entry.proposedEndedAt);
      const updated = await tx.timeEntry.updateMany({
        where: {
          id: entry.entryId,
          endedAt: null,
          trackingProtocolVersion: null,
        },
        data: {
          endedAt: proposedEndedAt,
          closeReason: 'LEGACY_RECONCILED',
          serverFinalizedAt: now,
          leaseExpiresAt: null,
        },
      });
      if (updated.count !== 1) throw new Error(`legacy_entry_changed:${entry.entryId}`);
      await tx.timeSegment.updateMany({
        where: { timeEntryId: entry.entryId, endedAt: null },
        data: { endedAt: proposedEndedAt },
      });
      await tx.user.updateMany({
        where: { id: entry.userId, agentActiveEntryId: entry.entryId },
        data: { agentActiveEntryId: null },
      });
    }
    for (const repair of lockedPlan.pointerRepairs) {
      const updated = await tx.user.updateMany({
        where: { id: repair.userId, agentActiveEntryId: repair.staleEntryId },
        data: { agentActiveEntryId: null },
      });
      if (updated.count !== 1) throw new Error(`legacy_pointer_changed:${repair.userId}`);
    }
    return {
      applied: lockedPlan.entries.length,
      repairedPointers: lockedPlan.pointerRepairs.length,
      planHash: lockedPlan.planHash,
    };
  });
}
