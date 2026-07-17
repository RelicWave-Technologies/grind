import type Database from 'better-sqlite3';
import { canonicalTimerEntryPayload, type ServerLedgerEntry, type TimeEntry } from '@grind/core';
import { TimeEntryDto, type TodayLedgerResponse } from '@grind/types';
import { createHash } from 'node:crypto';
import type { ServerLedgerCache, TimerOwner } from './types';

interface CachedRow {
  canonical_json: string;
  effective_json: string | null;
}

type EffectiveEntry = TodayLedgerResponse['effectiveEntries'][number];

export class SqliteTodayLedgerStore implements ServerLedgerCache {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_entry_cache (
        owner_user_id TEXT NOT NULL,
        owner_workspace_id TEXT NOT NULL,
        day_start INTEGER NOT NULL,
        day_end INTEGER NOT NULL,
        entry_id TEXT NOT NULL,
        client_uuid TEXT NOT NULL,
        revision INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        canonical_json TEXT NOT NULL,
        effective_json TEXT,
        PRIMARY KEY (owner_user_id, owner_workspace_id, day_start, entry_id)
      );
      CREATE INDEX IF NOT EXISTS idx_server_entry_cache_owner_day
        ON server_entry_cache(owner_user_id, owner_workspace_id, day_start, day_end);
      CREATE TABLE IF NOT EXISTS server_snapshot_meta (
        owner_user_id TEXT NOT NULL,
        owner_workspace_id TEXT NOT NULL,
        day_start INTEGER NOT NULL,
        day_end INTEGER NOT NULL,
        server_time INTEGER NOT NULL,
        workspace_timezone TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (owner_user_id, owner_workspace_id, day_start)
      );
    `);
    const columns = this.db.prepare(`PRAGMA table_info(server_entry_cache)`).all() as { name: string }[];
    if (!columns.some((column) => column.name === 'effective_json')) {
      this.db.exec(`ALTER TABLE server_entry_cache ADD COLUMN effective_json TEXT`);
    }
  }

  replaceSnapshot(
    owner: TimerOwner,
    window: { start: number; end: number },
    response: TodayLedgerResponse,
    fetchedAt = Date.now(),
  ): void {
    const autoEntries = response.entries.map((raw) => TimeEntryDto.parse(raw));
    const approvedManualEntries = (response.approvedManualEntries ?? []).map((raw) => TimeEntryDto.parse(raw));
    if (autoEntries.some((entry) => entry.userId !== owner.userId || entry.source !== 'AUTO')) {
      throw new Error('today_ledger_owner_mismatch');
    }
    if (approvedManualEntries.some((entry) => (
      entry.userId !== owner.userId
      || entry.source !== 'MANUAL'
      || entry.endedAt === null
      || entry.segments.some((segment) => segment.endedAt === null)
    ))) {
      throw new Error('today_ledger_manual_entry_invalid');
    }
    const entries = [...autoEntries, ...approvedManualEntries];
    const effectiveByEntry = validateEffectiveEntries(autoEntries, response.effectiveEntries);
    const serverTime = new Date(response.serverTime).getTime();
    if (!Number.isFinite(serverTime)) throw new Error('invalid_today_ledger_server_time');

    const replace = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM server_entry_cache
         WHERE owner_user_id = ? AND owner_workspace_id = ? AND day_start = ?`,
      ).run(owner.userId, owner.workspaceId, window.start);

      const insert = this.db.prepare(
        `INSERT INTO server_entry_cache (
           owner_user_id, owner_workspace_id, day_start, day_end,
           entry_id, client_uuid, revision, fetched_at, canonical_json, effective_json
         ) VALUES (
           @ownerUserId, @ownerWorkspaceId, @dayStart, @dayEnd,
           @entryId, @clientUuid, @revision, @fetchedAt, @json, @effectiveJson
         )`,
      );
      for (const entry of entries) {
        insert.run({
          ownerUserId: owner.userId,
          ownerWorkspaceId: owner.workspaceId,
          dayStart: window.start,
          dayEnd: window.end,
          entryId: entry.id,
          clientUuid: entry.clientUuid,
          revision: entry.revision ?? 0,
          fetchedAt,
          json: JSON.stringify(entry),
          effectiveJson: JSON.stringify(effectiveByEntry.get(entry.id) ?? fallbackEffectiveEntry(entry)),
        });
      }

      this.db.prepare(
        `INSERT INTO server_snapshot_meta (
           owner_user_id, owner_workspace_id, day_start, day_end,
           server_time, workspace_timezone, fetched_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_user_id, owner_workspace_id, day_start) DO UPDATE SET
           day_end = excluded.day_end,
           server_time = excluded.server_time,
           workspace_timezone = excluded.workspace_timezone,
           fetched_at = excluded.fetched_at`,
      ).run(
        owner.userId,
        owner.workspaceId,
        window.start,
        window.end,
        serverTime,
        response.workspaceTimezone,
        fetchedAt,
      );
    });
    replace();
  }

  list(owner: TimerOwner, windowStart: number, windowEnd: number, now: number): ServerLedgerEntry[] {
    const meta = this.db.prepare(
      `SELECT day_end FROM server_snapshot_meta
       WHERE owner_user_id = ? AND owner_workspace_id = ? AND day_start = ?`,
    ).get(owner.userId, owner.workspaceId, windowStart) as { day_end: number } | undefined;
    if (!meta || meta.day_end !== windowEnd) return [];

    const rows = this.db.prepare(
      `SELECT canonical_json, effective_json FROM server_entry_cache
       WHERE owner_user_id = ? AND owner_workspace_id = ? AND day_start = ? AND day_end = ?
       ORDER BY entry_id ASC`,
    ).all(owner.userId, owner.workspaceId, windowStart, windowEnd) as CachedRow[];
    try {
      return rows.map((row) => {
        const canonical = TimeEntryDto.parse(JSON.parse(row.canonical_json));
        let effective = fallbackEffectiveEntry(canonical);
        if (row.effective_json) {
          effective = parseEffectiveEntry(JSON.parse(row.effective_json), canonical);
        }
        const canonicalPayload = canonicalTimerEntryPayload(canonical);
        return {
          entry: toEffectiveCoreEntry(canonical, effective, now),
          canonicalPayload,
          canonicalHash: createHash('sha256').update(canonicalPayload).digest('hex'),
        };
      });
    } catch {
      // This cache is advisory. Never expose a partial snapshot or let corrupt
      // cache JSON block the durable local journal; the next refresh rewrites it.
      return [];
    }
  }
}

function toEffectiveCoreEntry(entry: TimeEntryDto, effective: EffectiveEntry, now: number): TimeEntry {
  const startedAt = new Date(entry.startedAt).getTime();
  const storedEndedAt = entry.endedAt === null ? null : new Date(entry.endedAt).getTime();
  const effectiveEndedAt = effective.endedAt === null ? null : new Date(effective.endedAt).getTime();
  const leaseExpiresAt = entry.leaseExpiresAt === null ? null : new Date(entry.leaseExpiresAt).getTime();
  const lastProvenAt = entry.lastProvenAt === null ? null : new Date(entry.lastProvenAt).getTime();
  const leaseExpiredEnd = entry.endedAt === null
    && entry.trackingProtocolVersion === 2
    && leaseExpiresAt !== null
    && leaseExpiresAt <= now
      ? Math.max(startedAt, Math.min(now, lastProvenAt ?? startedAt))
      : null;
  const endedAt = storedEndedAt ?? effectiveEndedAt ?? leaseExpiredEnd;
  const effectiveSegmentEnds = new Map(effective.segments.map((segment) => [segment.segmentId, segment.endedAt]));

  return {
    id: entry.id,
    clientUuid: entry.clientUuid,
    userId: entry.userId,
    larkTaskGuid: entry.larkTaskGuid,
    source: entry.source,
    revision: entry.revision ?? 0,
    startedAt,
    endedAt,
    pauseReason: null,
    closeReason: endedAt === null
      ? null
      : entry.closeReason === 'AGENT_RECOVERY'
        ? 'AGENT_RECOVERY'
        : 'AGENT',
    segments: entry.segments.map((segment) => ({
      id: segment.id,
      kind: segment.kind,
      startedAt: new Date(segment.startedAt).getTime(),
      endedAt: segment.endedAt !== null
        ? new Date(segment.endedAt).getTime()
        : effectiveSegmentEnds.get(segment.id)
          ? new Date(effectiveSegmentEnds.get(segment.id)!).getTime()
          : leaseExpiredEnd,
    })),
  };
}

function fallbackEffectiveEntry(entry: TimeEntryDto): EffectiveEntry {
  return {
    entryId: entry.id,
    endedAt: entry.endedAt,
    segments: entry.segments.map((segment) => ({ segmentId: segment.id, endedAt: segment.endedAt })),
  };
}

function parseEffectiveEntry(value: unknown, entry: TimeEntryDto): EffectiveEntry {
  const parsed = value as Partial<EffectiveEntry> | null;
  if (
    !parsed
    || parsed.entryId !== entry.id
    || (parsed.endedAt !== null && typeof parsed.endedAt !== 'string')
    || !Array.isArray(parsed.segments)
    || parsed.segments.some((segment) => (
      !segment
      || typeof segment.segmentId !== 'string'
      || (segment.endedAt !== null && typeof segment.endedAt !== 'string')
    ))
  ) {
    throw new Error('invalid_cached_today_ledger_effective_entry');
  }
  const effective = parsed as EffectiveEntry;
  validateEffectiveEntries([entry], [effective]);
  return effective;
}

function validateEffectiveEntries(
  entries: TimeEntryDto[],
  effectiveEntries: TodayLedgerResponse['effectiveEntries'],
): Map<string, EffectiveEntry> {
  if (effectiveEntries.length !== entries.length) throw new Error('incomplete_today_ledger_effective_entries');
  const byId = new Map<string, EffectiveEntry>();
  for (const effective of effectiveEntries) {
    if (byId.has(effective.entryId)) throw new Error('duplicate_today_ledger_effective_entry');
    byId.set(effective.entryId, effective);
  }
  for (const entry of entries) {
    const effective = byId.get(entry.id);
    if (!effective) throw new Error('missing_today_ledger_effective_entry');
    const entryStart = new Date(entry.startedAt).getTime();
    const effectiveEntryEnd = effective.endedAt === null ? null : new Date(effective.endedAt).getTime();
    if (effectiveEntryEnd !== null && effectiveEntryEnd < entryStart) {
      throw new Error('invalid_today_ledger_effective_entry_end');
    }
    const expected = new Set(entry.segments.map((segment) => segment.id));
    const actual = new Set(effective.segments.map((segment) => segment.segmentId));
    if (actual.size !== effective.segments.length || actual.size !== expected.size) {
      throw new Error('invalid_today_ledger_effective_segments');
    }
    for (const segmentId of actual) {
      if (!expected.has(segmentId)) throw new Error('foreign_today_ledger_effective_segment');
    }
    const starts = new Map(entry.segments.map((segment) => [segment.id, new Date(segment.startedAt).getTime()]));
    for (const segment of effective.segments) {
      const end = segment.endedAt === null ? null : new Date(segment.endedAt).getTime();
      if (end !== null && end < starts.get(segment.segmentId)!) {
        throw new Error('invalid_today_ledger_effective_segment_end');
      }
    }
  }
  return byId;
}
