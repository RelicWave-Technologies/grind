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
  buildApprovalCard,
  buildSupersededCard,
  buildUpdatedApprovalCard,
  buildCancelledCard,
  buildDecidedCard,
  getLarkMessenger,
  type DiffEntry,
} from '../lark';
import { logger } from '../logger';

export const timeRequestsRouter = Router();
timeRequestsRouter.use(requireAccessToken);

type Row = {
  id: string;
  clientUuid: string;
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
  attendees?: Array<{ userId: string }>;
  user?: { id: string; name: string; email: string; avatarUrl: string | null };
  approver?: { id: string; name: string; email: string; avatarUrl: string | null } | null;
};

function serialize(r: Row): ManualTimeRequestDto {
  return {
    id: r.id,
    clientUuid: r.clientUuid,
    userId: r.userId,
    approverId: r.approverId,
    larkTaskGuid: r.larkTaskGuid,
    taskSummary: r.taskSummary ?? null,
    larkMessageId: r.larkMessageId,
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
    select: { managerId: true },
  });
  if (requester?.managerId && requester.managerId !== requesterId) {
    const manager = await prisma.user.findFirst({
      where: {
        id: requester.managerId,
        workspaceId,
        deactivatedAt: null,
        role: { in: ['MANAGER', 'ADMIN'] },
      },
      select: {
        id: true,
        name: true,
        larkIdentity: { select: { openId: true } },
      },
    });
    if (manager) return manager;
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
 * 3. Self-requests from every role stay PENDING and use a non-self approver.
 * Lark sends are best-effort; DB state is the audit source of truth.
 */
timeRequestsRouter.post('/', attachScope, validate(CreateManualTimeRequest, 'body'), async (req, res, next) => {
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
      include: { attendees: true },
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
    const autoApprove = !target.isSelf;

    // ------------------------------------------------------------------
    // Branch A — supervisor edits for another user are approved at create time.
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
            autoApproved: true,
            decidedAt: now,
            decidedReason: `Added by ${actor.name}`,
            timeEntryId: teId,
            attendees: attendeeIds.length
              ? { create: attendeeIds.map((uid) => ({ userId: uid })) }
              : undefined,
          },
          include: { attendees: true },
        });
        return row;
      });

      // Best-effort informational card to the requester themselves so the
      // audit trail exists in Lark too. No buttons — pure record.
      const messenger = getLarkMessenger();
      if (messenger && requester.larkIdentity?.openId) {
        try {
          const card = buildDecidedCard({
            requestId: created.id,
            requesterName: requester.name,
            taskSummary: body.taskSummary ?? null,
            startedAt: start,
            endedAt: end,
            reason: body.reason,
            decision: 'APPROVED',
            decidedByName: actor.name,
            decidedAt: now.getTime(),
          });
          const { messageId } = await messenger.sendCard(requester.larkIdentity.openId, card);
          await prisma.manualTimeRequest.update({
            where: { id: created.id },
            data: { larkMessageId: messageId },
          });
          created.larkMessageId = messageId;
        } catch (err) {
          logger.warn(
            { err: String(err), requestId: created.id },
            'lark supervisor-edit notification failed (non-fatal)',
          );
        }
      }

      return res.status(201).json(serialize(created));
    }

    // ------------------------------------------------------------------
    // Branch B — self request → manager-first approver-pick + IM card flow.
    // ------------------------------------------------------------------
    const approver = await resolveManualTimeApprover(req.user.ws, targetUserId);
    if (!approver) return res.status(400).json({ error: 'no_approver' });

    const created = await prisma.manualTimeRequest.create({
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
        attendees: attendeeIds.length
          ? { create: attendeeIds.map((uid) => ({ userId: uid })) }
          : undefined,
      },
      include: { attendees: true },
    });

    const messenger = getLarkMessenger();
    if (messenger && approver.larkIdentity?.openId) {
      try {
        const card = buildApprovalCard({
          requestId: created.id,
          requesterName: requester.name,
          taskSummary: body.taskSummary ?? null,
          startedAt: start,
          endedAt: end,
          reason: body.reason,
        });
        const { messageId } = await messenger.sendCard(approver.larkIdentity.openId, card);
        await prisma.manualTimeRequest.update({ where: { id: created.id }, data: { larkMessageId: messageId } });
        created.larkMessageId = messageId;
      } catch (err) {
        logger.warn({ err: String(err), requestId: created.id }, 'lark approval card send failed (non-fatal)');
      }
    }

    res.status(201).json(serialize(created));
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
    const range = hasRange ? resolveReportRange(q as Record<string, unknown>) : null;
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
 * patch the request; RBAC scope is enforced before mutation. Re-sends the
 * updated approval card to the approver and a tiny "Request updated" text
 * nudge so they notice the change.
 * Both Lark calls are best-effort — they never block the DB write.
 */
timeRequestsRouter.patch('/:id', attachScope, validate(PatchManualTimeRequest, 'body'), async (req, res, next) => {
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
      return row;
    });

    // Best-effort: disable the OLD card (no buttons, "Updated — see new
    // card" notice) and send a NEW card showing the updated values + a diff
    // of what changed. Update DB's larkMessageId so future updates/
    // cancellations target the latest card. Failure must NOT break the
    // PATCH — the DB state is the source of truth.
    const messenger = getLarkMessenger();
    if (messenger && existing.approver?.larkIdentity?.openId && existing.larkMessageId) {
      const approverOpenId = existing.approver.larkIdentity.openId;
      const supersededAt = Date.now();
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
      if (existing.reason !== updated.reason) {
        diff.push({ label: 'Reason', before: existing.reason, after: updated.reason });
      }
      try {
        // 1. Disable the previous card.
        await messenger.updateCard(
          existing.larkMessageId,
          buildSupersededCard({
            requestId: existing.id,
            requesterName: existing.user.name,
            taskSummary: existing.taskSummary,
            startedAt: existing.requestedStart.getTime(),
            endedAt: existing.requestedEnd.getTime(),
            reason: existing.reason,
            supersededAt,
          }),
        );
        // 2. Send a fresh card with the updated values + the diff.
        const { messageId: newMessageId } = await messenger.sendCard(
          approverOpenId,
          buildUpdatedApprovalCard({
            requestId: updated.id,
            requesterName: existing.user.name,
            taskSummary: updated.taskSummary,
            startedAt: start.getTime(),
            endedAt: end.getTime(),
            reason: updated.reason,
            diff,
          }),
        );
        // 3. Future edits/cancellations should target the new card.
        await prisma.manualTimeRequest.update({ where: { id }, data: { larkMessageId: newMessageId } });
        updated.larkMessageId = newMessageId;
      } catch (err) {
        logger.warn({ err: String(err), requestId: id }, 'lark patch-notice failed (non-fatal)');
      }
    }
    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * Cancel a still-PENDING request. The requester or a scoped manager/admin can
 * cancel. Marks status=CANCELLED, swaps the original Lark card for a
 * "cancelled" variant (no buttons) and pings the approver with a one-line
 * notice so an in-flight approver doesn't act on a dead request. Decided
 * requests are immutable (409).
 */
timeRequestsRouter.post('/:id/cancel', attachScope, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
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

    const now = new Date();
    const updated = await prisma.manualTimeRequest.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        decidedAt: now,
        decidedReason: authz.isSelf ? 'Cancelled by requester' : 'Cancelled by manager',
      },
    });

    const messenger = getLarkMessenger();
    if (messenger && existing.larkMessageId) {
      try {
        // Rewrite the card in place: red header, NO Approve/Reject buttons,
        // clear "withdrawn by requester" note. After this, the approver
        // CAN'T act on stale buttons even if the WS callback fires.
        await messenger.updateCard(
          existing.larkMessageId,
          buildCancelledCard({
            requestId: existing.id,
            requesterName: existing.user.name,
            taskSummary: existing.taskSummary,
            startedAt: existing.requestedStart.getTime(),
            endedAt: existing.requestedEnd.getTime(),
            reason: existing.reason,
            cancelledAt: now.getTime(),
          }),
        );
      } catch (err) {
        logger.warn({ err: String(err), requestId: id }, 'lark cancel-card update failed (non-fatal)');
      }
    }
    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});

export default timeRequestsRouter;
