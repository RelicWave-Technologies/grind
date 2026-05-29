import { Router } from 'express';
import { prisma } from '@grind/db';
import {
  CreateTimeEntryRequest,
  ListTimeEntriesQuery,
  SyncTimeEntryRequest,
  type ListTimeEntriesResponse,
  type SegmentDto,
  type TimeEntryDto,
} from '@grind/types';
import { validateEntry, type Segment, type TimeEntry as CoreEntry } from '@grind/core';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { isLarkConfigured, getTokenManager, getUserTaskClient } from '../lark';
import { logger } from '../logger';

export const timeEntriesRouter = Router();

timeEntriesRouter.use(requireAccessToken);

/**
 * Best-effort: post a "started tracking" comment on the Lark task when a new
 * entry is created against it. Fire-and-forget — never blocks or fails tracking.
 */
async function postStartComment(userId: string, guid: string): Promise<void> {
  try {
    const tm = getTokenManager();
    const client = getUserTaskClient();
    if (!tm || !client) return;
    const accessToken = await tm.getAccessToken(userId);
    await client.addComment(accessToken, guid, '⏱ Started tracking in Grind');
  } catch (err) {
    logger.warn({ err: String(err), guid }, 'lark start-comment failed (non-fatal)');
  }
}

/** Map wire segments (ISO strings) to the core domain shape (epoch ms). */
function toCoreEntry(args: {
  id: string;
  clientUuid: string;
  userId: string;
  projectId: string | null;
  taskId: string | null;
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
    projectId: args.projectId,
    taskId: args.taskId,
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
  projectId: string | null;
  taskId: string | null;
  larkTaskGuid: string | null;
  source: 'AUTO' | 'MANUAL';
  startedAt: Date;
  endedAt: Date | null;
  segments: { id: string; kind: SegmentDto['kind']; startedAt: Date; endedAt: Date | null }[];
}): TimeEntryDto {
  return {
    id: entry.id,
    clientUuid: entry.clientUuid,
    userId: entry.userId,
    projectId: entry.projectId,
    taskId: entry.taskId,
    larkTaskGuid: entry.larkTaskGuid,
    source: entry.source,
    startedAt: entry.startedAt.toISOString(),
    endedAt: entry.endedAt ? entry.endedAt.toISOString() : null,
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

/**
 * Create a time entry (idempotent on clientUuid). If the entry already exists,
 * return it unchanged (the agent retried). The project must belong to the
 * caller's workspace.
 */
timeEntriesRouter.post('/', validate(CreateTimeEntryRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as CreateTimeEntryRequest;

    // Idempotency: existing clientUuid => return as-is.
    const existing = await prisma.timeEntry.findUnique({
      where: { clientUuid: body.clientUuid },
      include: { segments: true },
    });
    if (existing) {
      if (existing.userId !== req.user.sub) return res.status(409).json({ error: 'client_uuid_conflict' });
      return res.status(200).json(serialize(existing));
    }

    // Validate the project (if any) is in the caller's workspace. Entries are
    // now attributed to a Lark task, so projectId is optional.
    if (body.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: body.projectId, workspaceId: req.user.ws },
        select: { id: true },
      });
      if (!project) return res.status(400).json({ error: 'invalid_project' });

      if (body.taskId) {
        const task = await prisma.task.findFirst({
          where: { id: body.taskId, projectId: body.projectId },
          select: { id: true },
        });
        if (!task) return res.status(400).json({ error: 'invalid_task' });
      }
    }

    // Segment integrity check (defense in depth, shared domain logic).
    const core = toCoreEntry({
      id: body.id,
      clientUuid: body.clientUuid,
      userId: req.user.sub,
      projectId: body.projectId ?? null,
      taskId: body.taskId ?? null,
      source: body.source,
      startedAt: body.startedAt,
      endedAt: null,
      segments: body.segments,
    });
    const violations = validateEntry(core);
    if (violations.length) return res.status(400).json({ error: 'invalid_segments', details: violations });

    const created = await prisma.timeEntry.create({
      data: {
        id: body.id,
        clientUuid: body.clientUuid,
        userId: req.user.sub,
        projectId: body.projectId ?? null,
        taskId: body.taskId ?? null,
        larkTaskGuid: body.larkTaskGuid ?? null,
        source: body.source,
        startedAt: new Date(body.startedAt),
        agentVersion: body.agentVersion,
        platform: body.platform,
        segments: {
          create: body.segments.map((s) => ({
            id: s.id,
            kind: s.kind,
            startedAt: new Date(s.startedAt),
            endedAt: s.endedAt ? new Date(s.endedAt) : null,
          })),
        },
      },
      include: { segments: true },
    });
    if (created.larkTaskGuid && isLarkConfigured()) {
      void postStartComment(req.user.sub, created.larkTaskGuid);
    }
    res.status(201).json(serialize(created));
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

    const entry = await prisma.timeEntry.findUnique({ where: { id }, select: { id: true, userId: true, clientUuid: true, projectId: true, taskId: true, source: true, startedAt: true } });
    if (!entry) return res.status(404).json({ error: 'not_found' });
    if (entry.userId !== req.user.sub) return res.status(403).json({ error: 'forbidden' });

    const core = toCoreEntry({
      id: entry.id,
      clientUuid: entry.clientUuid,
      userId: entry.userId,
      projectId: entry.projectId,
      taskId: entry.taskId,
      source: entry.source,
      startedAt: entry.startedAt.toISOString(),
      endedAt: body.endedAt ?? null,
      segments: body.segments,
    });
    const violations = validateEntry(core);
    if (violations.length) return res.status(400).json({ error: 'invalid_segments', details: violations });

    const incomingIds = body.segments.map((s) => s.id);
    const updated = await prisma.$transaction(async (tx) => {
      // Replace segments idempotently: drop this entry's segments AND any rows
      // that reuse an incoming id (defends against replayed/retried syncs),
      // then recreate. Avoids unique-constraint collisions on TimeSegment.id.
      await tx.timeSegment.deleteMany({
        where: { OR: [{ timeEntryId: id }, { id: { in: incomingIds } }] },
      });
      await tx.timeEntry.update({
        where: { id },
        data: { endedAt: body.endedAt ? new Date(body.endedAt) : null },
      });
      await tx.timeSegment.createMany({
        data: body.segments.map((s) => ({
          id: s.id,
          timeEntryId: id,
          kind: s.kind,
          startedAt: new Date(s.startedAt),
          endedAt: s.endedAt ? new Date(s.endedAt) : null,
        })),
      });
      return tx.timeEntry.findUniqueOrThrow({ where: { id }, include: { segments: true } });
    });

    res.json(serialize(updated));
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
