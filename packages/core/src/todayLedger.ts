import { canonicalTimerEntryPayload } from './timerLedger';
import { COUNTED_KINDS, type TimeEntry } from './types';

export type LedgerSyncState = 'pending_create' | 'pending_update' | 'synced';
export type LedgerConflict =
  | 'REVISION_PAYLOAD_CONFLICT'
  | 'ACKNOWLEDGED_SERVER_CORRECTION'
  | 'SERVER_NEWER'
  | 'SERVER_MISSING'
  | 'OVERLAP';

export interface LocalLedgerEntry {
  entry: TimeEntry;
  syncState: LedgerSyncState;
  acknowledgedRevision?: number | null;
  acknowledgedHash?: string | null;
}

export interface ServerLedgerEntry {
  /** Effective entry used by UI/totals; canonical hash remains unmodified. */
  entry: TimeEntry;
  canonicalPayload: string;
  canonicalHash: string;
}

export interface LedgerProjectionEntry {
  entry: TimeEntry;
  origin: 'LOCAL' | 'SERVER';
  pending: boolean;
  conflicts: LedgerConflict[];
}

export interface TodayLedgerProjection {
  entries: LedgerProjectionEntry[];
  workedMs: number;
  conflicts: number;
}

function canonical(entry: TimeEntry): string {
  return canonicalTimerEntryPayload(entry);
}

function matchingServer(
  local: TimeEntry,
  byId: ReadonlyMap<string, ServerLedgerEntry>,
  byClientUuid: ReadonlyMap<string, ServerLedgerEntry>,
): ServerLedgerEntry | undefined {
  return byId.get(local.id) ?? byClientUuid.get(local.clientUuid);
}

/**
 * Pure reconciliation. It never mutates either source and never treats a
 * server fetch as permission to delete the local journal.
 */
export function reconcileTodayLedger(input: {
  local: readonly LocalLedgerEntry[];
  server: readonly ServerLedgerEntry[];
  activeLocalEntryId?: string | null;
  windowStart: number;
  windowEnd: number;
  now: number;
}): TodayLedgerProjection {
  const serverById = new Map(input.server.map((item) => [item.entry.id, item]));
  const serverByClientUuid = new Map(input.server.map((item) => [item.entry.clientUuid, item]));
  const consumedServerIds = new Set<string>();
  const projected: LedgerProjectionEntry[] = [];

  for (const local of input.local) {
    const server = matchingServer(local.entry, serverById, serverByClientUuid);
    if (!server) {
      projected.push({
        entry: local.entry,
        origin: 'LOCAL',
        pending: local.syncState !== 'synced',
        conflicts: local.syncState === 'synced' ? ['SERVER_MISSING'] : [],
      });
      continue;
    }
    consumedServerIds.add(server.entry.id);

    const localHash = canonical(local.entry);
    const samePayload = localHash === server.canonicalPayload;
    if (local.entry.revision === server.entry.revision && samePayload) {
      const locallyActive = local.entry.id === input.activeLocalEntryId;
      projected.push({
        entry: locallyActive ? local.entry : server.entry,
        origin: locallyActive ? 'LOCAL' : 'SERVER',
        pending: local.syncState !== 'synced',
        conflicts: [],
      });
      continue;
    }

    const acknowledgedCorrection = local.acknowledgedRevision === server.entry.revision
      && local.acknowledgedHash === server.canonicalHash;
    if (acknowledgedCorrection) {
      projected.push({
        entry: server.entry,
        origin: 'SERVER',
        pending: false,
        conflicts: ['ACKNOWLEDGED_SERVER_CORRECTION'],
      });
      continue;
    }

    if (local.entry.revision > server.entry.revision) {
      projected.push({
        entry: local.entry,
        origin: 'LOCAL',
        pending: true,
        conflicts: [],
      });
      continue;
    }

    if (local.entry.revision === server.entry.revision) {
      projected.push({
        entry: local.entry,
        origin: 'LOCAL',
        pending: local.syncState !== 'synced',
        conflicts: ['REVISION_PAYLOAD_CONFLICT'],
      });
      continue;
    }

    projected.push({
      entry: server.entry,
      origin: 'SERVER',
      pending: false,
      conflicts: ['SERVER_NEWER'],
    });
  }

  for (const server of input.server) {
    if (!consumedServerIds.has(server.entry.id)) {
      projected.push({ entry: server.entry, origin: 'SERVER', pending: false, conflicts: [] });
    }
  }

  projected.sort((a, b) => b.entry.startedAt - a.entry.startedAt || a.entry.id.localeCompare(b.entry.id));
  const intervals = countedIntervals(projected, input.windowStart, input.windowEnd, input.now);
  const overlapIds = overlappingEntryIds(intervals);
  if (overlapIds.size > 0) {
    for (const item of projected.filter((candidate) => overlapIds.has(candidate.entry.id))) {
      if (item.conflicts.length === 0) item.conflicts = ['OVERLAP'];
      else if (!item.conflicts.includes('OVERLAP')) item.conflicts.push('OVERLAP');
    }
  }

  return {
    entries: projected,
    workedMs: unionDuration(intervals),
    conflicts: projected.filter((entry) => entry.conflicts.length > 0).length,
  };
}

function countedIntervals(
  entries: readonly LedgerProjectionEntry[],
  windowStart: number,
  windowEnd: number,
  now: number,
): Array<{ entryId: string; start: number; end: number }> {
  const effectiveNow = Math.min(now, windowEnd);
  return entries
    .flatMap(({ entry }) => entry.segments
      .filter((segment) => COUNTED_KINDS.includes(segment.kind))
      .map((segment) => ({
        entryId: entry.id,
        start: Math.max(windowStart, segment.startedAt),
        end: Math.min(windowEnd, segment.endedAt ?? effectiveNow),
      })))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function overlappingEntryIds(
  intervals: readonly { entryId: string; start: number; end: number }[],
): Set<string> {
  const overlapping = new Set<string>();
  let active: Array<{ entryId: string; end: number }> = [];
  for (const interval of intervals) {
    active = active.filter((candidate) => candidate.end > interval.start);
    for (const candidate of active) {
      if (candidate.entryId === interval.entryId) continue;
      overlapping.add(candidate.entryId);
      overlapping.add(interval.entryId);
    }
    active.push({ entryId: interval.entryId, end: interval.end });
  }
  return overlapping;
}

function unionDuration(intervals: readonly { start: number; end: number }[]): number {
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const interval of intervals) {
    if (start === null || end === null) {
      start = interval.start;
      end = interval.end;
      continue;
    }
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
      continue;
    }
    total += end - start;
    start = interval.start;
    end = interval.end;
  }
  return start === null || end === null ? total : total + end - start;
}
