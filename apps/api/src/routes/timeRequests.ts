import { Router } from 'express';
import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import {
  CreateManualTimeRequest,
  ListManualTimeRequestsQuery,
  PatchManualTimeRequest,
  type CreateManualTimeRequest as CreateBody,
  type ManualTimeRequestDto,
  type ListManualTimeRequestsQuery as ListQuery,
  type PatchManualTimeRequest as PatchBody,
} from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { attachScope } from '../middleware/scope';
import { authorizeTimeEditForUser, resolveTimeEditTarget } from '../authz/timeEdit';
import { resolveReportRange } from '../reports/member';
import {
  type DiffEntry,
} from '../lark';
import {
  queueManualTimeApprovalCard,
  queueManualTimeSupersedeOldCards,
} from '../manualTime/larkOutbox';
import { cancelManualTimeRequest } from '../manualTime/decision';
import { activeManagersForHomeTeam } from '../org/teamManagers';

export const timeRequestsRouter = Router();
timeRequestsRouter.use(requireAccessToken, attachScope);

type Row = {
  id: string;
  clientUuid: string;
  version?: number;
  userId: string;
  approverId: string | null;
  larkTaskGuid: string | null;
  taskSummary: string | null;
  larkMessageId: string | null;
  requestedStart: Date;
  requestedEnd: Date;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  autoApproved?: boolean;
  decidedAt: Date | null;
  decidedReason: string | null;
  createdAt: Date;
  larkMessages?: Array<{ status: string; attempts: number; version: number; createdAt: Date }>;
  attendees?: Array<{ userId: string }>;
  user?: { id: string; name: string; email: string; avatarUrl: string | null };
  approver?: { id: string; name: string; email: string; avatarUrl: string | null } | null;
};

function larkDelivery(row: Row): { larkDeliveryStatus: 'none' | 'queued' | 'sent' | 'retrying' | 'failed'; latestLarkMessageStatus: string | null } {
  const latest = row.larkMessages
    ?.slice()
    .sort((a, b) => b.version - a.version || b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) return { larkDeliveryStatus: row.larkMessageId ? 'sent' : 'none', latestLarkMessageStatus: row.larkMessageId ? 'SENT' : null };
  if (latest.status === 'SENT' || latest.status === 'DECIDED' || latest.status === 'CANCELLED' || latest.status === 'SUPERSEDED') {
    return { larkDeliveryStatus: 'sent', latestLarkMessageStatus: latest.status };
  }
  if (latest.status === 'SEND_FAILED' || latest.status === 'UPDATE_FAILED') {
    return { larkDeliveryStatus: latest.attempts >= 25 ? 'failed' : 'retrying', latestLarkMessageStatus: latest.status };
  }
  return { larkDeliveryStatus: 'queued', latestLarkMessageStatus: latest.status };
}

function serialize(r: Row): ManualTimeRequestDto {
  const delivery = larkDelivery(r);
  return {
    id: r.id,
    clientUuid: r.clientUuid,
    version: r.version ?? 1,
    userId: r.userId,
    approverId: r.approverId,
    larkTaskGuid: r.larkTaskGuid,
    taskSummary: r.taskSummary ?? null,
    larkMessageId: r.larkMessageId,
    larkDeliveryStatus: delivery.larkDeliveryStatus,
    latestLarkMessageStatus: delivery.latestLarkMessageStatus,
    requestedStart: r.requestedStart.toISOString(),
    requestedEnd: r.requestedEnd.toISOString(),
    reason: r.reason,
    status: r.status,
    autoApproved: r.autoApproved ?? false,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decidedReason: r.decidedReason,
    createdAt: r.createdAt.toISOString(),
    attendeeIds: r.attendees ? r.attendees.map((a) => a.userId) : undefined,
    user: r.user,
    approver: r.approver ?? undefined,
  };
}

function cleanTaskSummary(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

function canSelfApproveManualTime(role: string): boolean {
  return role === 'ADMIN' || role === 'MANAGER';
}

/**
 * Validate the optional `attendeeIds` against a workspace. Returns the
 * cleaned set (deduped, requester excluded) or an error code suitable
 * for a 400 response.
 */
async function validateAttendees(
  workspaceId: string,
  requesterId: string,
  ids: string[] | undefined,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  if (!ids || ids.length === 0) return { ok: true, ids: [] };
  const deduped = [...new Set(ids)].filter((id) => id !== requesterId);
  if (deduped.length === 0) return { ok: true, ids: [] };
  const found = await prisma.user.findMany({
    where: { id: { in: deduped }, workspaceId },
    select: { id: true },
  });
  if (found.length !== deduped.length) {
    return { ok: false, error: 'attendee_out_of_workspace' };
  }
  return { ok: true, ids: deduped };
}

async function resolveManualTimeApprover(
  workspaceId: string,
  requesterId: string,
): Promise<{
  id: string;
  name: string;
  larkIdentity: { openId: string } | null;
} | null> {
  const requester = await prisma.user.findUnique({
    where: { id: requesterId },
    select: { teamId: true },
  });
  if (requester?.teamId) {
    const managers = await activeManagersForHomeTeam(workspaceId, requester.teamId, requesterId);
    if (managers[0]) return managers[0];
  }

  return prisma.user.findFirst({
    where: {
      workspaceId,
      id: { not: requesterId },
      role: 'ADMIN',
      deactivatedAt: null,
    },
    select: {
      id: true,
      name: true,
      larkIdentity: { select: { openId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Submit a manual-time request. Idempotent on `clientUuid`.
 *
 * 1. Resolves the target user through time-edit RBAC.
 * 2. Manager/admin edits for another user create APPROVED manual time immediately.
 * 3. Manager/admin self-requests are APPROVED immediately; member self-requests
 *    stay PENDING and use a separate approver.
 * Lark sends are best-effort; DB state is the audit source of truth.
 */
timeRequestsRouter.post('/', validate(CreateManualTimeRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as CreateBody;

    // Range sanity (cheap guard before DB work).
    const start = new Date(body.requestedStart).getTime();
    const end = new Date(body.requestedEnd).getTime();
    if (!(start < end)) return res.status(400).json({ error: 'invalid_range' });

    const target = resolveTimeEditTarget(req, body.userId);
    if (!target.ok) return res.status(target.status).json({ error: target.error });
    const targetUserId = target.targetUserId;

    // Idempotency: same clientUuid from this user → return existing row.
    const existing = await prisma.manualTimeRequest.findUnique({
      where: { clientUuid: body.clientUuid },
      include: {
        attendees: true,
        larkMessages: { select: { status: true, attempts: true, version: true, createdAt: true } },
      },
    });
    if (existing) {
      if (existing.userId !== targetUserId) return res.status(409).json({ error: 'client_uuid_conflict' });
      return res.status(200).json(serialize(existing));
    }

    // Attendees: validate within workspace, dedupe, exclude requester.
    const attendeeCheck = await validateAttendees(req.user.ws, targetUserId, body.attendeeIds);
    if (!attendeeCheck.ok) return res.status(400).json({ error: attendeeCheck.error });
    const attendeeIds = attendeeCheck.ids;

    const requester = await prisma.user.findUniqueOrThrow({
      where: { id: targetUserId },
      select: { id: true, name: true, shiftId: true, larkIdentity: { select: { openId: true } } },
    });
    const actor =
      target.isSelf
        ? requester
        : await prisma.user.findUniqueOrThrow({
            where: { id: req.user.sub },
            select: { id: true, name: true },
          });
    const autoApprove = !target.isSelf || canSelfApproveManualTime(req.user.role);

    // ------------------------------------------------------------------
    // Branch A — supervisor edits and supervisor self-requests are approved at create time.
    // ------------------------------------------------------------------
    if (autoApprove) {
      const now = new Date();
      const created = await prisma.$transaction(async (tx) => {
        const teId = ulid();
        await tx.timeEntry.create({
          data: {
            id: teId,
            clientUuid: `mtr-auto-${ulid()}`,
            userId: targetUserId,
            larkTaskGuid: body.larkTaskGuid ?? null,
            source: 'MANUAL',
            startedAt: new Date(start),
            endedAt: new Date(end),
            shiftIdAtStart: requester.shiftId ?? null,
            segments: {
              create: [
                { id: ulid(), kind: 'WORK', startedAt: new Date(start), endedAt: new Date(end) },
              ],
            },
            attendees: attendeeIds.length
              ? { create: attendeeIds.map((uid) => ({ userId: uid })) }
              : undefined,
          },
        });
        const row = await tx.manualTimeRequest.create({
          data: {
            clientUuid: body.clientUuid,
            userId: targetUserId,
            approverId: req.user!.sub,
            larkTaskGuid: body.larkTaskGuid ?? null,
            taskSummary: cleanTaskSummary(body.taskSummary),
            requestedStart: new Date(start),
            requestedEnd: new Date(end),
            reason: body.reason,
            status: 'APPROVED',
            version: 1,
            autoApproved: true,
            decidedAt: now,
            decidedById: req.user!.sub,
            decisionSource: 'AUTO_APPROVE',
            decidedReason: `Added by ${actor.name}`,
            timeEntryId: teId,
            attendees: attendeeIds.length
              ? { create: attendeeIds.map((uid) => ({ userId: uid })) }
            : undefined,
          },
          include: { attendees: true },
        });
        if (requester.larkIdentity?.openId) {
          await queueManualTimeApprovalCard(tx, {
            requestId: row.id,
            version: row.version,
            recipientOpenId: requester.larkIdentity.openId,
            kind: 'DECIDED_NOTICE',
          });
        }
        return row;
      });

      const hydrated = await prisma.manualTimeRequest.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          attendees: true,
          larkMessages: { select: { status: true, attempts: true, version: true, createdAt: true } },
        },
      });
      return res.status(201).json(serialize(hydrated));
    }

    // ------------------------------------------------------------------
    // Branch B — self request → manager-first approver-pick + IM card flow.
    // ------------------------------------------------------------------
    const approver = await resolveManualTimeApprover(req.user.ws, targetUserId);
    if (!approver) return res.status(400).json({ error: 'no_approver' });

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.manualTimeRequest.create({
        data: {
          clientUuid: body.clientUuid,
          userId: targetUserId,
          approverId: approver.id,
          larkTaskGuid: body.larkTaskGuid ?? null,
          taskSummary: cleanTaskSummary(body.taskSummary),
          requestedStart: new Date(start),
          requestedEnd: new Date(end),
          reason: body.reason,
          status: 'PENDING',
          version: 1,
          attendees: attendeeIds.length
            ? { create: attendeeIds.map((uid) => ({ userId: uid })) }
            : undefined,
        },
        include: { attendees: true },
      });
      if (approver.larkIdentity?.openId) {
        await queueManualTimeApprovalCard(tx, {
          requestId: row.id,
          version: row.version,
          recipientOpenId: approver.larkIdentity.openId,
          kind: 'APPROVAL',
        });
      }
      return row;
    });

    const hydrated = await prisma.manualTimeRequest.findUniqueOrThrow({
      where: { id: created.id },
      include: {
        attendees: true,
        larkMessages: { select: { status: true, attempts: true, version: true, createdAt: true } },
      },
    });

    res.status(201).json(serialize(hydrated));
  } catch (err) {
    next(err);
  }
});

/**
 * List manual-time requests scoped to the caller.
 * - `?role=mine` (default): requests the caller submitted.
 * - `?role=approvals`: requests where the caller is the approver.
 * Optional `?status=` filter.
 */
timeRequestsRouter.get('/', validate(ListManualTimeRequestsQuery, 'query'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const q = req.query as unknown as ListQuery;
    const hasRange = q.from !== undefined || q.to !== undefined || q.tz !== undefined;
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const range = hasRange ? resolveReportRange(q as Record<string, unknown>, req.scope.workspaceTimezone) : null;
    if (range && 'error' in range) {
      return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    }
    const where =
      q.role === 'approvals'
        ? {
            approverId: req.user.sub,
            ...(q.status ? { status: q.status } : {}),
            ...(range && !('error' in range)
              ? { requestedStart: { lt: range.rangeEnd }, requestedEnd: { gt: range.rangeStart } }
              : {}),
          }
        : {
            userId: req.user.sub,
            ...(q.status ? { status: q.status } : {}),
            ...(range && !('error' in range)
              ? { requestedStart: { lt: range.rangeEnd }, requestedEnd: { gt: range.rangeStart } }
              : {}),
          };
    const rows = await prisma.manualTimeRequest.findMany({
      where,
      orderBy: hasRange ? [{ requestedStart: 'desc' }, { createdAt: 'desc' }] : [{ createdAt: 'desc' }],
      take: 200,
      include: {
        attendees: true,
        larkMessages: { select: { status: true, attempts: true, version: true, createdAt: true } },
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
        approver: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    });
    res.json({
      requests: rows.map(serialize),
      ...(range && !('error' in range) ? { from: range.from, to: range.to, tz: range.tz } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Edit a still-PENDING request. The requester or a scoped manager/admin can
 * patch the request; DB mutation and Lark projection jobs are written in one
 * transaction. Old cards are rejected by version even if Lark updates lag.
 */
timeRequestsRouter.patch('/:id', validate(PatchManualTimeRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.manualTimeRequest.findUnique({
      where: { id },
      include: {
        user: { select: { name: true } },
        approver: { include: { larkIdentity: { select: { openId: true } } } },
      },
    });
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const authz = authorizeTimeEditForUser(req, existing.userId);
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'immutable_after_decision', status: existing.status });

    const body = req.body as PatchBody;
    // Range sanity if both edges are touched (or one is touched + existing).
    const start = body.requestedStart ? new Date(body.requestedStart) : existing.requestedStart;
    const end = body.requestedEnd ? new Date(body.requestedEnd) : existing.requestedEnd;
    if (!(start.getTime() < end.getTime())) return res.status(400).json({ error: 'invalid_range' });

    // Validate attendees if present in the patch.
    let attendeeIds: string[] | null = null;
    if (body.attendeeIds !== undefined) {
      const check = await validateAttendees(req.user.ws, existing.userId, body.attendeeIds);
      if (!check.ok) return res.status(400).json({ error: check.error });
      attendeeIds = check.ids;
    }

	    const updated = await prisma.$transaction(async (tx) => {
	      const row = await tx.manualTimeRequest.update({
	        where: { id },
	        data: {
	          requestedStart: start,
	          requestedEnd: end,
	          version: { increment: 1 },
	          ...(body.larkTaskGuid !== undefined ? { larkTaskGuid: body.larkTaskGuid } : {}),
	          ...(body.taskSummary !== undefined ? { taskSummary: cleanTaskSummary(body.taskSummary) } : {}),
	          ...(body.reason !== undefined ? { reason: body.reason } : {}),
        },
      });
      if (attendeeIds !== null) {
        // Replace-all semantics: drop old attendees, insert new ones.
        await tx.mtrAttendee.deleteMany({ where: { requestId: id } });
        if (attendeeIds.length) {
          await tx.mtrAttendee.createMany({
            data: attendeeIds.map((userId) => ({ requestId: id, userId })),
	          });
	        }
	      }
	      if (existing.approver?.larkIdentity?.openId) {
	        const diff: DiffEntry[] = [];
	        if (existing.requestedStart.getTime() !== start.getTime() || existing.requestedEnd.getTime() !== end.getTime()) {
	          diff.push({
	            label: 'Time',
	            before: `${existing.requestedStart.toISOString()} → ${existing.requestedEnd.toISOString()}`,
	            after: `${start.toISOString()} → ${end.toISOString()}`,
	          });
	        }
	        const nextTaskGuid = body.larkTaskGuid !== undefined ? body.larkTaskGuid : existing.larkTaskGuid;
	        const nextTaskSummary = body.taskSummary !== undefined ? cleanTaskSummary(body.taskSummary) : existing.taskSummary;
	        if ((existing.larkTaskGuid ?? null) !== (nextTaskGuid ?? null) || (existing.taskSummary ?? null) !== (nextTaskSummary ?? null)) {
	          const beforeTask = existing.taskSummary ?? existing.larkTaskGuid ?? '—';
	          const afterTask = nextTaskSummary ?? nextTaskGuid ?? '—';
	          diff.push({ label: 'Task', before: beforeTask, after: afterTask });
	        }
	        if (existing.reason !== row.reason) {
	          diff.push({ label: 'Reason', before: existing.reason, after: row.reason });
	        }
	        await queueManualTimeApprovalCard(tx, {
	          requestId: row.id,
	          version: row.version,
	          recipientOpenId: existing.approver.larkIdentity.openId,
	          kind: 'UPDATED_APPROVAL',
	          diff,
	        });
	        await queueManualTimeSupersedeOldCards(tx, row.id);
	      }
	      return row;
	    });

	    const hydrated = await prisma.manualTimeRequest.findUniqueOrThrow({
	      where: { id: updated.id },
	      include: {
	        attendees: true,
	        larkMessages: { select: { status: true, attempts: true, version: true, createdAt: true } },
	      },
	    });
	    res.json(serialize(hydrated));
  } catch (err) {
    next(err);
  }
});

/**
 * Cancel a still-PENDING request. The DB transition is atomic and all known
 * Lark cards are finalized asynchronously via the outbox.
 */
timeRequestsRouter.post('/:id/cancel', attachScope, async (req, res, next) => {
  try {
	    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
	    const id = req.params.id;
	    if (!id) return res.status(400).json({ error: 'missing_id' });
	    const existing = await prisma.manualTimeRequest.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const authz = authorizeTimeEditForUser(req, existing.userId);
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'immutable_after_decision', status: existing.status });

    await cancelManualTimeRequest({
      requestId: id,
      actorUserId: req.user.sub,
      reason: authz.isSelf ? 'Cancelled by requester' : 'Cancelled by manager',
      source: authz.isSelf ? 'REQUESTER_CANCEL' : 'MANAGER_CANCEL',
    });

    const updated = await prisma.manualTimeRequest.findUniqueOrThrow({
      where: { id },
      include: {
        attendees: true,
        larkMessages: { select: { status: true, attempts: true, version: true, createdAt: true } },
      },
    });
    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});

export default timeRequestsRouter;
