import { prisma } from '@grind/db';

const MIN = 60 * 1000;

export const LIVE_HEARTBEAT_FRESH_MS = 3 * MIN;
export const CLIENT_CLOCK_SKEW_MS = 2 * MIN;

export interface EntryRef {
  id: string;
  userId: string;
  endedAt?: Date | null;
}

export interface EntryLiveEvidence {
  latestStoredProofAt: Date | null;
  latestHeartbeatAt: Date | null;
}

export type EntryLiveEvidenceMap = Map<string, EntryLiveEvidence>;

export function heartbeatIsFresh(
  evidence: EntryLiveEvidence | null | undefined,
  now: Date,
  notBefore?: Date,
): boolean {
  const heartbeatMs = evidence?.latestHeartbeatAt?.getTime();
  return heartbeatMs !== undefined
    && heartbeatMs <= now.getTime()
    && heartbeatMs >= now.getTime() - LIVE_HEARTBEAT_FRESH_MS
    && (notBefore === undefined || heartbeatMs >= notBefore.getTime());
}

export function trustedObservedAt(input: {
  observedAt: Date;
  receivedAt: Date;
  now: Date;
}): Date | null {
  const observedMs = input.observedAt.getTime();
  const receivedMs = input.receivedAt.getTime();
  const nowMs = input.now.getTime();
  if (!Number.isFinite(observedMs) || !Number.isFinite(receivedMs)) return null;
  if (observedMs > receivedMs + CLIENT_CLOCK_SKEW_MS || observedMs > nowMs + CLIENT_CLOCK_SKEW_MS) {
    return null;
  }
  return new Date(Math.min(observedMs, receivedMs, nowMs));
}

/**
 * Loads the one server-bounded evidence snapshot used by every time surface.
 * Client timestamps can prove no later than the server receipt that stored them.
 */
export async function loadEntryLiveEvidence(entries: EntryRef[], now = new Date()): Promise<EntryLiveEvidenceMap> {
  const refs = new Map(
    entries
      .filter((entry) => entry.endedAt === null || entry.endedAt === undefined)
      .map((entry) => [entry.id, entry.userId]),
  );
  const entryIds = [...refs.keys()];
  if (entryIds.length === 0) return new Map();

  const userIds = [...new Set(refs.values())];
  const futureLimit = new Date(now.getTime() + CLIENT_CLOCK_SKEW_MS);
  const [samples, screenshots, runtimes] = await Promise.all([
    prisma.activitySample.findMany({
      where: {
        timeEntryId: { in: entryIds },
        bucketStart: { lte: futureLimit },
      },
      distinct: ['timeEntryId'],
      orderBy: [{ timeEntryId: 'asc' }, { bucketStart: 'desc' }],
      select: { timeEntryId: true, bucketStart: true, createdAt: true },
    }),
    prisma.screenshot.findMany({
      where: {
        timeEntryId: { in: entryIds },
        capturedAt: { lte: futureLimit },
        deletedAt: null,
      },
      distinct: ['timeEntryId'],
      orderBy: [{ timeEntryId: 'asc' }, { capturedAt: 'desc' }],
      select: { timeEntryId: true, capturedAt: true, createdAt: true },
    }),
    prisma.user.findMany({
      where: {
        id: { in: userIds },
        agentState: 'RUNNING',
        agentActiveEntryId: { in: entryIds },
        agentLastSeenAt: { lte: now },
      },
      select: { id: true, agentActiveEntryId: true, agentLastSeenAt: true },
    }),
  ]);

  const evidence: EntryLiveEvidenceMap = new Map(
    entryIds.map((entryId) => [entryId, { latestStoredProofAt: null, latestHeartbeatAt: null }]),
  );
  const recordStoredProof = (entryId: string | null, observedAt: Date, receivedAt: Date) => {
    if (!entryId) return;
    const bounded = trustedObservedAt({ observedAt, receivedAt, now });
    const current = evidence.get(entryId);
    if (!bounded || !current) return;
    if (!current.latestStoredProofAt || bounded > current.latestStoredProofAt) {
      current.latestStoredProofAt = bounded;
    }
  };

  for (const sample of samples) {
    recordStoredProof(
      sample.timeEntryId,
      new Date(sample.bucketStart.getTime() + MIN),
      sample.createdAt,
    );
  }
  for (const screenshot of screenshots) {
    recordStoredProof(screenshot.timeEntryId, screenshot.capturedAt, screenshot.createdAt);
  }
  for (const runtime of runtimes) {
    const entryId = runtime.agentActiveEntryId;
    if (!entryId || !runtime.agentLastSeenAt || refs.get(entryId) !== runtime.id) continue;
    evidence.get(entryId)!.latestHeartbeatAt = runtime.agentLastSeenAt;
  }

  return evidence;
}
