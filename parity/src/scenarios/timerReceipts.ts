import type Database from 'better-sqlite3';
import { canonicalTimerEntryPayload, type TimeEntry } from '@grind/core';
import type { NetItem } from '../legacyStubs/timerState';
import type { DeliverySpec, Owner } from './timerTypes';
import { sha256hex } from './timerWorld';

const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;

/** The `TimerSyncReceipt` a real server would answer one queued request with. */
export function buildReceipt(item: NetItem, spec: Extract<DeliverySpec, { kind: 'ok' }>, serverTimeMs: number): unknown {
  const entry = item.entry as TimeEntry;
  const body = JSON.parse(item.body) as {
    revision: number;
    observedAt: string;
    closeReason: string | null;
    startedAt?: string;
    endedAt: string | null;
    segments: unknown[];
  };
  const canonicalEntry = {
    id: entry.id,
    clientUuid: entry.clientUuid,
    userId: entry.userId,
    larkTaskGuid: entry.larkTaskGuid ?? null,
    source: entry.source,
    trackingProtocolVersion: 2,
    revision: body.revision,
    lastProvenAt: body.observedAt,
    leaseExpiresAt: body.endedAt === null ? iso(serverTimeMs + 3 * MIN) : null,
    closeReason: body.closeReason,
    serverFinalizedAt: null,
    startedAt: body.startedAt ?? iso(entry.startedAt),
    endedAt: body.endedAt,
    notes: null,
    segments: body.segments,
  };
  let canonicalHash: string;
  if (spec.hash === 'server') canonicalHash = sha256hex(canonicalTimerEntryPayload(canonicalEntry as never));
  else if (spec.hash === 'agent') canonicalHash = sha256hex(canonicalTimerEntryPayload(entry));
  else if (spec.hash === 'zeros') canonicalHash = '0'.repeat(64);
  else canonicalHash = 'abc';
  return {
    disposition: spec.disposition ?? 'APPLIED',
    acceptedRevision: body.revision + (spec.revDelta ?? 0),
    canonicalHash,
    canonicalEntry,
    serverTime: iso(serverTimeMs),
    correction: spec.correction ?? null,
  };
}

/** A response the zod schema must refuse. */
export function buildMalformed(item: NetItem, variant: number, serverTimeMs: number): unknown {
  const good = buildReceipt(item, { kind: 'ok', hash: 'zeros' }, serverTimeMs) as Record<string, unknown>;
  switch (variant % 5) {
    case 0:
      return {};
    case 1:
      return { ...good, acceptedRevision: -1 };
    case 2:
      return { ...good, serverTime: 'garbage' };
    case 3:
      return null;
    default:
      return { ...good, canonicalEntry: { ...(good.canonicalEntry as object), segments: 'none' } };
  }
}

export type SnapshotMod = 'skip' | 'copy' | 'older' | 'newer' | 'closed' | 'otherUser';

export interface SnapshotOp {
  mods: SnapshotMod[];
  manual: boolean;
  extraAuto: boolean;
  window: { start: number; end: number };
  serverTimeOffset: number;
}

type Dto = {
  id: string; clientUuid: string; userId: string; larkTaskGuid: string | null; source: string;
  trackingProtocolVersion: number | null; revision: number | null; lastProvenAt: string | null;
  leaseExpiresAt: string | null; closeReason: string | null; serverFinalizedAt: string | null;
  startedAt: string; endedAt: string | null; notes: string | null;
  segments: Array<{ id: string; kind: string; startedAt: string; endedAt: string | null }>;
};

function dtoFrom(local: TimeEntry, mod: SnapshotMod, owner: Owner, serverTimeMs: number): Dto {
  const lastEnd = local.segments.reduce((m, s) => Math.max(m, s.endedAt ?? s.startedAt), local.startedAt);
  const closeIt = mod === 'closed' && local.endedAt === null;
  const endedAt = local.endedAt ?? (closeIt ? lastEnd : null);
  return {
    id: local.id,
    clientUuid: local.clientUuid,
    userId: mod === 'otherUser' ? 'someone-else' : owner.userId,
    larkTaskGuid: local.larkTaskGuid ?? null,
    source: local.source,
    trackingProtocolVersion: 2,
    revision: mod === 'older' ? Math.max(0, local.revision - 1) : mod === 'newer' ? local.revision + 1 : local.revision,
    lastProvenAt: iso(lastEnd),
    leaseExpiresAt: endedAt === null ? iso(Math.min(serverTimeMs, lastEnd) - 1000) : null,
    closeReason: endedAt === null ? null : local.closeReason ?? 'AGENT',
    serverFinalizedAt: null,
    startedAt: iso(local.startedAt),
    endedAt: endedAt === null ? null : iso(endedAt),
    notes: null,
    segments: local.segments.map((s) => ({
      id: s.id,
      kind: s.kind,
      startedAt: iso(s.startedAt),
      endedAt: s.endedAt === null ? (closeIt ? iso(lastEnd) : null) : iso(s.endedAt),
    })),
  };
}

/** A `TodayLedgerResponse` derived from what the local journal holds right now. */
export function buildSnapshot(db: Database.Database, owner: Owner, op: SnapshotOp): unknown {
  const serverTimeMs = op.window.start + op.serverTimeOffset;
  const rows = db
    .prepare('SELECT json FROM local_entries WHERE owner_user_id = ? AND owner_workspace_id = ? ORDER BY rowid')
    .all(owner.userId, owner.workspaceId) as Array<{ json: string }>;
  const entries: Dto[] = [];
  rows.forEach((row, index) => {
    const mod = op.mods.length === 0 ? 'copy' : op.mods[index % op.mods.length]!;
    if (mod === 'skip') return;
    entries.push(dtoFrom(JSON.parse(row.json) as TimeEntry, mod, owner, serverTimeMs));
  });
  if (op.extraAuto) {
    entries.push({
      id: 'SERVER-ONLY',
      clientUuid: 'server-only-client',
      userId: owner.userId,
      larkTaskGuid: 'server-task',
      source: 'AUTO',
      trackingProtocolVersion: 2,
      revision: 3,
      lastProvenAt: iso(op.window.start + 5 * MIN),
      leaseExpiresAt: iso(op.window.start + 8 * MIN),
      closeReason: null,
      serverFinalizedAt: null,
      startedAt: iso(op.window.start + MIN),
      endedAt: null,
      notes: null,
      segments: [{ id: 'SERVER-SEG', kind: 'WORK', startedAt: iso(op.window.start + MIN), endedAt: null }],
    });
  }
  const effectiveEntries = entries.map((entry) => ({
    entryId: entry.id,
    endedAt: entry.endedAt ?? (entry.lastProvenAt && entry.leaseExpiresAt ? entry.lastProvenAt : null),
    segments: entry.segments.map((s) => ({
      segmentId: s.id,
      endedAt: s.endedAt ?? (entry.endedAt === null && entry.lastProvenAt && entry.leaseExpiresAt ? entry.lastProvenAt : null),
    })),
  }));
  const response: Record<string, unknown> = {
    complete: true,
    serverTime: iso(serverTimeMs),
    workspaceTimezone: 'Asia/Kolkata',
    entries,
    effectiveEntries,
  };
  if (op.manual) {
    response.approvedManualEntries = [{
      id: 'MANUAL-1', clientUuid: 'manual-client', userId: owner.userId, larkTaskGuid: 'manual-task', source: 'MANUAL',
      trackingProtocolVersion: null, revision: null, lastProvenAt: null, leaseExpiresAt: null, closeReason: null,
      serverFinalizedAt: null, startedAt: iso(op.window.start + 20 * MIN), endedAt: iso(op.window.start + 50 * MIN), notes: null,
      segments: [{ id: 'MANUAL-SEG', kind: 'WORK', startedAt: iso(op.window.start + 20 * MIN), endedAt: iso(op.window.start + 50 * MIN) }],
    }];
  }
  return response;
}
