import { prisma } from '@grind/db';

import {
  CLIENT_CLOCK_SKEW_MS,
  trustedObservedAt,
  type EntryLiveEvidenceMap,
} from '@grind/core';

const MIN = 60 * 1000;

export interface EntryRef {
  id: string;
  userId: string;
  endedAt?: Date | null;
  trackingProtocolVersion?: number | null;
}

interface LatestProof {
  timeEntryId: string;
  observedAt: Date;
  createdAt: Date;
}

/**
 * Loads the one server-bounded evidence snapshot used by every time surface.
 * Client timestamps can prove no later than the server receipt that stored them.
 */
export async function loadEntryLiveEvidence(entries: EntryRef[], now = new Date()): Promise<EntryLiveEvidenceMap> {
  const open = entries.filter((entry) => entry.endedAt === null || entry.endedAt === undefined);
  const refs = new Map(open.map((entry) => [entry.id, entry.userId]));
  const entryIds = [...refs.keys()];
  if (entryIds.length === 0) return new Map();

  // A v2 timer proves itself with its lease (see effectiveSegmentEnd), so its
  // samples and screenshots would be read for nothing. The heartbeat is still
  // loaded for every entry: "tracking now" is answered from it.
  const legacyIds = open.filter((entry) => entry.trackingProtocolVersion !== 2).map((entry) => entry.id);
  const userIds = [...new Set(refs.values())];
  const futureLimit = new Date(now.getTime() + CLIENT_CLOCK_SKEW_MS);
  const [samples, screenshots, runtimes] = await Promise.all([
    latestSamples(legacyIds, futureLimit),
    latestScreenshots(legacyIds, futureLimit),
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
  const recordStoredProof = (entryId: string, observedAt: Date, receivedAt: Date) => {
    const bounded = trustedObservedAt({ observedAt, receivedAt, now });
    const current = evidence.get(entryId);
    if (!bounded || !current) return;
    if (!current.latestStoredProofAt || bounded > current.latestStoredProofAt) {
      current.latestStoredProofAt = bounded;
    }
  };

  for (const sample of samples) {
    // A sample covers the minute that starts at bucketStart.
    recordStoredProof(sample.timeEntryId, new Date(sample.observedAt.getTime() + MIN), sample.createdAt);
  }
  for (const screenshot of screenshots) {
    recordStoredProof(screenshot.timeEntryId, screenshot.observedAt, screenshot.createdAt);
  }
  for (const runtime of runtimes) {
    const entryId = runtime.agentActiveEntryId;
    if (!entryId || !runtime.agentLastSeenAt || refs.get(entryId) !== runtime.id) continue;
    evidence.get(entryId)!.latestHeartbeatAt = runtime.agentLastSeenAt;
  }

  return evidence;
}

/*
 * The latest sample / screenshot per entry, one index probe each
 * ((timeEntryId, bucketStart) and (timeEntryId, capturedAt)). Only the newest
 * row of an entry is ever used, and an entry left open for days has thousands
 * — reading them all to keep one ran on every overview and report load.
 * Stored times are UTC `timestamp`s, so the bound is converted the same way.
 */

function latestSamples(entryIds: string[], notAfter: Date): Promise<LatestProof[]> {
  if (entryIds.length === 0) return Promise.resolve([]);
  return prisma.$queryRaw<LatestProof[]>`
    SELECT e.id AS "timeEntryId", s."bucketStart" AS "observedAt", s."createdAt"
    FROM unnest(${entryIds}::text[]) AS e(id)
    CROSS JOIN LATERAL (
      SELECT "bucketStart", "createdAt"
      FROM "ActivitySample"
      WHERE "timeEntryId" = e.id AND "bucketStart" <= (${notAfter.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "bucketStart" DESC
      LIMIT 1
    ) s
  `;
}

function latestScreenshots(entryIds: string[], notAfter: Date): Promise<LatestProof[]> {
  if (entryIds.length === 0) return Promise.resolve([]);
  return prisma.$queryRaw<LatestProof[]>`
    SELECT e.id AS "timeEntryId", s."capturedAt" AS "observedAt", s."createdAt"
    FROM unnest(${entryIds}::text[]) AS e(id)
    CROSS JOIN LATERAL (
      SELECT "capturedAt", "createdAt"
      FROM "Screenshot"
      WHERE "timeEntryId" = e.id AND "capturedAt" <= (${notAfter.toISOString()}::timestamptz AT TIME ZONE 'UTC') AND "deletedAt" IS NULL
      ORDER BY "capturedAt" DESC
      LIMIT 1
    ) s
  `;
}
