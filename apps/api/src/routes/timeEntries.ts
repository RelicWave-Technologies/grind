import { Router } from 'express';
import { prisma, type TimeEntryCloseReason } from '@grind/db';
import {
  CreateTimeEntryRequest,
  ListTimeEntriesQuery,
  PatchTimeEntryRequest,
  SyncTimeEntryRequest,
  type ListTimeEntriesResponse,
  type PatchTimeEntryRequest as PatchBody,
  type SegmentDto,
  type TimeEntryDto,
} from '@grind/types';
import { validateEntry, clampEntryToServerClock, type Segment, type TimeEntry as CoreEntry } from '@grind/core';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { attachScope } from '../middleware/scope';
import { authorizeTimeEditForUser } from '../authz/timeEdit';
import { queueManualTimeFinalizeCards } from '../manualTime/larkOutbox';
import { logger } from '../logger';
import {
  lockTimerOwner,
  supersedeExpiredTimersForUser,
  TIMER_LEASE_MS,
  TIMER_PROTOCOL_VERSION,
} from '../timeLifecycle';

export const timeEntriesRouter = Router();

timeEntriesRouter.use(requireAccessToken);

/** Map wire segments (ISO strings) to the core domain shape (epoch ms). */
function toCoreEntry(args: {
  id: string;
  clientUuid: string;
  userId: string;
  source: 'AUTO' | 'MANUAL';
  startedAt: string;
  endedAt: string | null;
  segments: SegmentDto[];
}): CoreEntry {
  const segments: Segment[] = args.segments.map((s) => ({
    id: s.id,
    kind: s.kind,
    startedAt: new Date(s.startedAt).getTime(),
    endedAt: s.endedAt ? new Date(s.endedAt).getTime() : null,
  }));
  return {
    id: args.id,
    clientUuid: args.clientUuid,
    userId: args.userId,
    source: args.source,
    startedAt: new Date(args.startedAt).getTime(),
    endedAt: args.endedAt ? new Date(args.endedAt).getTime() : null,
    segments,
  };
}

function serialize(entry: {
  id: string;
  clientUuid: string;
  userId: string;
  larkTaskGuid: string | null;
  source: 'AUTO' | 'MANUAL';
  trackingProtocolVersion: number | null;
  agentRevision: number | null;
  lastProvenAt: Date | null;
  leaseExpiresAt: Date | null;
  closeReason: TimeEntryCloseReason | null;
  serverFinalizedAt: Date | null;
  startedAt: Date;
  endedAt: Date | null;
  notes: string | null;
  segments: { id: string; kind: SegmentDto['kind']; startedAt: Date; endedAt: Date | null }[];
}): TimeEntryDto {
  return {
    id: entry.id,
    clientUuid: entry.clientUuid,
    userId: entry.userId,
    larkTaskGuid: entry.larkTaskGuid,
    source: entry.source,
    trackingProtocolVersion: entry.trackingProtocolVersion,
    revision: entry.agentRevision,
    lastProvenAt: entry.lastProvenAt?.toISOString() ?? null,
    leaseExpiresAt: entry.leaseExpiresAt?.toISOString() ?? null,
    closeReason: entry.closeReason,
    serverFinalizedAt: entry.serverFinalizedAt?.toISOString() ?? null,
    startedAt: entry.startedAt.toISOString(),
    endedAt: entry.endedAt ? entry.endedAt.toISOString() : null,
    notes: entry.notes ?? null,
    segments: entry.segments
      .slice()
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      })),
  };
}

function hasCompleteV2Lifecycle(input: {
  trackingProtocolVersion?: number;
  revision?: number;
  observedAt?: string;
  closeReason?: string | null;
}): boolean {
  return input.trackingProtocolVersion === TIMER_PROTOCOL_VERSION
    && input.revision !== undefined
    && input.observedAt !== undefined;
}

function hasAnyLifecycleField(input: {
  trackingProtocolVersion?: number;
  revision?: number;
  observedAt?: string;
  closeReason?: string | null;
}): boolean {
  return input.trackingProtocolVersion !== undefined
    || input.revision !== undefined
    || input.observedAt !== undefined
    || input.closeReason !== undefined;
}

function clampObservedAt(observedAt: string, now: Date, startedAt: Date): Date {
  const raw = new Date(observedAt).getTime();
  const bounded = Number.isFinite(raw) ? Math.min(raw, now.getTime()) : now.getTime();
  return new Date(Math.max(startedAt.getTime(), bounded));
}

/**
 * Create a time entry (idempotent on clientUuid). If the entry already exists,
 * return it unchanged (the agent retried). The project must belong to the
 * caller's workspace.
 */
timeEntriesRouter.post('/', validate(CreateTimeEntryRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as CreateTimeEntryRequest;
    if (hasAnyLifecycleField(body) && !hasCompleteV2Lifecycle(body)) {
      return res.status(400).json({ error: 'incomplete_timer_lifecycle' });
    }
    const isV2 = hasCompleteV2Lifecycle(body);
    if (isV2 && body.source !== 'AUTO') {
      return res.status(400).json({ error: 'timer_lifecycle_requires_auto_entry' });
    }

    // Idempotency: existing clientUuid => return as-is.
    const existing = await prisma.timeEntry.findUnique({
      where: { clientUuid: body.clientUuid },
      include: { segments: true },
    });
    if (existing) {
      if (existing.userId !== req.user.sub) return res.status(409).json({ error: 'client_uuid_conflict' });
      return res.status(200).json(serialize(existing));
    }

    // Segment integrity check (defense in depth, shared domain logic).
    const core = toCoreEntry({
      id: body.id,
      clientUuid: body.clientUuid,
      userId: req.user.sub,
      source: body.source,
      startedAt: body.startedAt,
      endedAt: body.endedAt ?? null,
      segments: body.segments,
    });
    const violations = validateEntry(core);
    if (violations.length) return res.status(400).json({ error: 'invalid_segments', details: violations });

    // Server-authoritative clock clamp: never trust the laptop's clock to push
    // time into the future. A fast/tampered client clock can't inflate hours.
    const clamped = clampEntryToServerClock(core, Date.now());
    if (clamped.adjusted) {
      logger.warn(
        { userId: req.user.sub, entryId: body.id, notes: clamped.notes },
        'time-entry create: clamped future timestamps to server clock',
      );
    }

    const now = new Date();
    const lastProvenAt = isV2
      ? clampObservedAt(body.observedAt!, now, new Date(clamped.entry.startedAt))
      : null;
    const outcome = await prisma.$transaction(async (tx) => {
      if (isV2 && clamped.entry.endedAt === null) {
        await lockTimerOwner(tx, req.user!.sub);
        const racedExisting = await tx.timeEntry.findUnique({
          where: { clientUuid: body.clientUuid },
          include: { segments: true },
        });
        if (racedExisting) {
          return racedExisting.userId === req.user!.sub
            ? { kind: 'existing' as const, entry: racedExisting }
            : { kind: 'clientUuidConflict' as const };
        }
      }
      const shiftSnapshot = await tx.user.findUnique({
        where: { id: req.user!.sub },
        select: { shiftId: true },
      });
      if (isV2 && clamped.entry.endedAt === null) {
        const activeEntryId = await supersedeExpiredTimersForUser(tx, req.user!.sub, now);
        if (activeEntryId) return { kind: 'conflict' as const, activeEntryId };
      }
      const created = await tx.timeEntry.create({
        data: {
          id: body.id,
          clientUuid: body.clientUuid,
          userId: req.user!.sub,
          larkTaskGuid: body.larkTaskGuid ?? null,
          source: body.source,
          startedAt: new Date(clamped.entry.startedAt),
          endedAt: clamped.entry.endedAt !== null ? new Date(clamped.entry.endedAt) : null,
          trackingProtocolVersion: isV2 ? TIMER_PROTOCOL_VERSION : null,
          agentRevision: isV2 ? body.revision : null,
          lastProvenAt,
          leaseExpiresAt: isV2 && clamped.entry.endedAt === null
            ? new Date(now.getTime() + TIMER_LEASE_MS)
            : null,
          closeReason: clamped.entry.endedAt !== null
            ? (body.closeReason ?? (isV2 ? 'AGENT' : null))
            : null,
          agentVersion: body.agentVersion,
          platform: body.platform,
          shiftIdAtStart: shiftSnapshot?.shiftId ?? null,
          segments: {
            create: clamped.entry.segments.map((s) => ({
              id: s.id,
              kind: s.kind,
              startedAt: new Date(s.startedAt),
              endedAt: s.endedAt ? new Date(s.endedAt) : null,
            })),
          },
        },
        include: { segments: true },
      });
      return { kind: 'created' as const, entry: created };
    });
    if (outcome.kind === 'conflict') {
      return res.status(409).json({ error: 'active_timer_conflict', activeEntryId: outcome.activeEntryId });
    }
    if (outcome.kind === 'clientUuidConflict') {
      return res.status(409).json({ error: 'client_uuid_conflict' });
    }
    if (outcome.kind === 'existing') return res.status(200).json(serialize(outcome.entry));
    res.status(201).json(serialize(outcome.entry));
  } catch (err) {
    next(err);
  }
});

/**
 * Sync an entry's segments (and optionally close it). The agent owns the truth
 * for a running entry, so we replace the segment set wholesale. Idempotent.
 */
timeEntriesRouter.put('/:id/sync', validate(SyncTimeEntryRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const body = req.body as SyncTimeEntryRequest;
    if (hasAnyLifecycleField(body) && !hasCompleteV2Lifecycle(body)) {
      return res.status(400).json({ error: 'incomplete_timer_lifecycle' });
    }
    const isV2 = hasCompleteV2Lifecycle(body);

    const entry = await prisma.timeEntry.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        clientUuid: true,
        source: true,
        startedAt: true,
        trackingProtocolVersion: true,
        agentRevision: true,
      },
    });
    if (!entry) return res.status(404).json({ error: 'not_found' });
    if (entry.userId !== req.user.sub) return res.status(403).json({ error: 'forbidden' });
    if (entry.trackingProtocolVersion === TIMER_PROTOCOL_VERSION && !isV2) {
      return res.status(409).json({ error: 'timer_protocol_required' });
    }

    const core = toCoreEntry({
      id: entry.id,
      clientUuid: entry.clientUuid,
      userId: entry.userId,
      source: entry.source,
      startedAt: entry.startedAt.toISOString(),
      endedAt: body.endedAt ?? null,
      segments: body.segments,
    });
    const violations = validateEntry(core);
    if (violations.length) return res.status(400).json({ error: 'invalid_segments', details: violations });

    // Server-authoritative clock clamp (same guard as create): the agent owns
    // the running entry's segments, but never the right to bill future time.
    const clamped = clampEntryToServerClock(core, Date.now());
    if (clamped.adjusted) {
      logger.warn(
        { userId: req.user.sub, entryId: id, notes: clamped.notes },
        'time-entry sync: clamped future timestamps to server clock',
      );
    }
    const clampedSegments = clamped.entry.segments;
    const clampedEndedAt = clamped.entry.endedAt;

    const incomingIds = clampedSegments.map((s) => s.id);
    const now = new Date();
    const outcome = await prisma.$transaction(async (tx) => {
      if (isV2) await lockTimerOwner(tx, entry.userId);
      await tx.$queryRaw`SELECT "id" FROM "TimeEntry" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.timeEntry.findUniqueOrThrow({ where: { id }, include: { segments: true } });

      const currentRevision = current.agentRevision ?? 0;
      if (isV2 && body.revision! < currentRevision) {
        return { kind: 'ok' as const, entry: current };
      }

      const checkpointAt = isV2 ? clampObservedAt(body.observedAt!, now, current.startedAt) : null;
      const observedAt = checkpointAt && current.lastProvenAt && current.lastProvenAt > checkpointAt
        ? current.lastProvenAt
        : checkpointAt;
      if (current.endedAt) {
        if (current.closeReason === 'SUPERSEDED') {
          return {
            kind: 'conflict' as const,
            payload: { error: 'timer_finalized', endedAt: current.endedAt.toISOString() },
          };
        }

        if (current.closeReason === 'LEASE_EXPIRED') {
          const mayReconcile = isV2
            && body.revision! > currentRevision
            && observedAt !== null
            && observedAt > current.endedAt;
          if (!mayReconcile) return { kind: 'ok' as const, entry: current };

          const otherActive = await tx.timeEntry.findFirst({
            where: {
              id: { not: id },
              userId: current.userId,
              source: 'AUTO',
              endedAt: null,
              trackingProtocolVersion: TIMER_PROTOCOL_VERSION,
            },
            select: { id: true },
          });
          if (otherActive) {
            return {
              kind: 'conflict' as const,
              payload: { error: 'timer_conflict', activeEntryId: otherActive.id },
            };
          }
        } else if (clampedEndedAt === null) {
          return {
            kind: 'conflict' as const,
            payload: { error: 'timer_finalized', endedAt: current.endedAt.toISOString() },
          };
        }
      }

      // Replace segments idempotently: drop this entry's segments AND any rows
      // that reuse an incoming id (defends against replayed/retried syncs),
      // then recreate. Avoids unique-constraint collisions on TimeSegment.id.
      await tx.timeSegment.deleteMany({
        where: { OR: [{ timeEntryId: id }, { id: { in: incomingIds } }] },
      });
      await tx.timeEntry.update({
        where: { id },
        data: {
          endedAt: clampedEndedAt !== null ? new Date(clampedEndedAt) : null,
          trackingProtocolVersion: isV2 ? TIMER_PROTOCOL_VERSION : current.trackingProtocolVersion,
          agentRevision: isV2 ? body.revision : current.agentRevision,
          lastProvenAt: observedAt ?? current.lastProvenAt,
          leaseExpiresAt: isV2 && clampedEndedAt === null
            ? new Date(now.getTime() + TIMER_LEASE_MS)
            : null,
          closeReason: clampedEndedAt !== null
            ? (body.closeReason ?? (isV2 ? 'AGENT' : current.closeReason))
            : null,
          serverFinalizedAt: null,
        },
      });
      await tx.timeSegment.createMany({
        data: clampedSegments.map((s) => ({
          id: s.id,
          timeEntryId: id,
          kind: s.kind,
          startedAt: new Date(s.startedAt),
          endedAt: s.endedAt ? new Date(s.endedAt) : null,
        })),
      });
      const updated = await tx.timeEntry.findUniqueOrThrow({ where: { id }, include: { segments: true } });
      return { kind: 'ok' as const, entry: updated };
    });

    if (outcome.kind === 'conflict') return res.status(409).json(outcome.payload);
    res.json(serialize(outcome.entry));
  } catch (err) {
    next(err);
  }
});

/** List the caller's own time entries within an optional window. */
timeEntriesRouter.get('/', validate(ListTimeEntriesQuery, 'query'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const q = req.query as unknown as ListTimeEntriesQuery;
    const entries = await prisma.timeEntry.findMany({
      where: {
        userId: req.user.sub,
        startedAt: {
          gte: q.from ? new Date(q.from) : undefined,
          lte: q.to ? new Date(q.to) : undefined,
        },
      },
      orderBy: { startedAt: 'desc' },
      take: q.limit,
      include: { segments: true },
    });
    const response: ListTimeEntriesResponse = { entries: entries.map(serialize) };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH an entry's metadata (task attribution + user-facing notes). Cannot
 * change start/end/segments — those are the OS-tracked truth, audit-sensitive,
 * and reserved for the M11 admin EDIT-request flow. Used by the Edit Time
 * tab's inline-editable green rows.
 *
 * No approval needed: re-attributing your own tracked time to a different
 * Lark task or adding a note is metadata, not new tracked time.
 */
timeEntriesRouter.patch('/:id', attachScope, validate(PatchTimeEntryRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.timeEntry.findUnique({
      where: { id },
      select: { userId: true, segments: { select: { kind: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const authz = authorizeTimeEditForUser(req, existing.userId);
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });

    const body = req.body as PatchBody;

    // Attendees can only be tagged on entries that contain a MEETING segment.
    // (Tracked WORK + idle entries don't carry meeting attribution.)
    let nextAttendees: string[] | null = null;
    if (body.attendeeIds !== undefined) {
      const hasMeeting = existing.segments.some((s) => s.kind === 'MEETING');
      if (!hasMeeting) {
        return res.status(400).json({ error: 'attendees_require_meeting_segment' });
      }
      const dedup = [...new Set(body.attendeeIds)].filter((uid) => uid !== existing.userId);
      if (dedup.length > 0) {
        const found = await prisma.user.findMany({
          where: { id: { in: dedup }, workspaceId: req.user.ws },
          select: { id: true },
        });
        if (found.length !== dedup.length) {
          return res.status(400).json({ error: 'attendee_out_of_workspace' });
        }
      }
      nextAttendees = dedup;
    }

    const data: { larkTaskGuid?: string | null; notes?: string | null } = {};
    if (body.larkTaskGuid !== undefined) data.larkTaskGuid = body.larkTaskGuid;
    if (body.notes !== undefined) data.notes = body.notes;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.timeEntry.update({
        where: { id },
        data,
        include: { segments: true },
      });
      if (nextAttendees !== null) {
        await tx.timeEntryAttendee.deleteMany({ where: { timeEntryId: id } });
        if (nextAttendees.length) {
          await tx.timeEntryAttendee.createMany({
            data: nextAttendees.map((userId) => ({ timeEntryId: id, userId })),
          });
        }
      }
      return row;
    });
    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * Delete approved/manual added time. Only MANUAL entries can be removed here;
 * AUTO entries remain agent-owned audit records. If the manual entry came from
 * a ManualTimeRequest, mark that request CANCELLED first so approval history
 * explains why the linked timesheet row disappeared.
 */
timeEntriesRouter.delete('/:id', attachScope, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });

    const existing = await prisma.timeEntry.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        source: true,
        manualTimeRequest: { select: { id: true } },
      },
    });
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const authz = authorizeTimeEditForUser(req, existing.userId);
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    if (existing.source !== 'MANUAL') return res.status(400).json({ error: 'not_manual_time' });

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      if (existing.manualTimeRequest) {
        await tx.manualTimeRequest.update({
          where: { id: existing.manualTimeRequest.id },
          data: {
            status: 'CANCELLED',
            version: { increment: 1 },
            decidedAt: now,
            decidedReason: authz.isSelf ? 'Deleted by requester' : 'Deleted by manager',
            decidedById: req.user!.sub,
            decisionSource: authz.isSelf ? 'REQUESTER_CANCEL' : 'MANAGER_CANCEL',
            timeEntryId: null,
          },
        });
        await queueManualTimeFinalizeCards(tx, existing.manualTimeRequest.id);
      }
      await tx.timeEntry.delete({ where: { id } });
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
