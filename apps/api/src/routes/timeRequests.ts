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

/** Roles that auto-approve their own manual-time requests at create time. */
const SELF_AUTO_APPROVE_ROLES = new Set(['OWNER', 'ADMIN', 'MANAGER']);

export const timeRequestsRouter = Router();
timeRequestsRouter.use(requireAccessToken);

type Row = {
  id: string;
  clientUuid: string;
  userId: string;
  approverId: string | null;
  larkTaskGuid: string | null;
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
};

function serialize(r: Row): ManualTimeRequestDto {
  return {
    id: r.id,
    clientUuid: r.clientUuid,
    userId: r.userId,
    approverId: r.approverId,
    larkTaskGuid: r.larkTaskGuid,
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
  };
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

/**
 * Submit a manual-time request. Idempotent on `clientUuid`.
 *
 * 1. Picks an approver — any ADMIN or OWNER in the same workspace, other than
 *    the requester. (Team.managerId-based scoping lands with M11.)
 * 2. Persists the row with status=PENDING.
 * 3. If Lark is configured and the approver has a Lark identity, sends an
 *    interactive card via the bot and stores `larkMessageId`. Sending failures
 *    do NOT block the request — the row stays PENDING and the dashboard
 *    mirror (also M11) can drive the decision.
 */
timeRequestsRouter.post('/', validate(CreateManualTimeRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as CreateBody;

    // Range sanity (cheap guard before DB work).
    const start = new Date(body.requestedStart).getTime();
    const end = new Date(body.requestedEnd).getTime();
    if (!(start < end)) return res.status(400).json({ error: 'invalid_range' });

    // Idempotency: same clientUuid from this user → return existing row.
    const existing = await prisma.manualTimeRequest.findUnique({
      where: { clientUuid: body.clientUuid },
      include: { attendees: true },
    });
    if (existing) {
      if (existing.userId !== req.user.sub) return res.status(409).json({ error: 'client_uuid_conflict' });
      return res.status(200).json(serialize(existing));
    }

    // Attendees: validate within workspace, dedupe, exclude requester.
    const attendeeCheck = await validateAttendees(req.user.ws, req.user.sub, body.attendeeIds);
    if (!attendeeCheck.ok) return res.status(400).json({ error: attendeeCheck.error });
    const attendeeIds = attendeeCheck.ids;

    const requester = await prisma.user.findUniqueOrThrow({
      where: { id: req.user.sub },
      select: { name: true, role: true, shiftId: true, larkIdentity: { select: { openId: true } } },
    });
    const autoApprove = SELF_AUTO_APPROVE_ROLES.has(requester.role);

    // ------------------------------------------------------------------
    // Branch A — MANAGER+ self-approve at create time.
    // ------------------------------------------------------------------
    if (autoApprove) {
      const now = new Date();
      const created = await prisma.$transaction(async (tx) => {
        const teId = ulid();
        await tx.timeEntry.create({
          data: {
            id: teId,
            clientUuid: `mtr-auto-${ulid()}`,
            userId: req.user!.sub,
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
            userId: req.user!.sub,
            approverId: req.user!.sub, // self is the approver of record
            larkTaskGuid: body.larkTaskGuid ?? null,
            requestedStart: new Date(start),
            requestedEnd: new Date(end),
            reason: body.reason,
            status: 'APPROVED',
            autoApproved: true,
            decidedAt: now,
            decidedReason: 'Auto-approved (manager-or-above own request)',
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
            decidedByName: `${requester.name} (auto)`,
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
            'lark auto-approve self-notification failed (non-fatal)',
          );
        }
      }

      return res.status(201).json(serialize(created));
    }

    // ------------------------------------------------------------------
    // Branch B — MEMBER → traditional approver-pick + IM card flow.
    // ------------------------------------------------------------------
    const approver = await prisma.user.findFirst({
      where: { workspaceId: req.user.ws, id: { not: req.user.sub }, role: { in: ['ADMIN', 'OWNER'] } },
      include: { larkIdentity: { select: { openId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!approver) return res.status(400).json({ error: 'no_approver' });

    const created = await prisma.manualTimeRequest.create({
      data: {
        clientUuid: body.clientUuid,
        userId: req.user.sub,
        approverId: approver.id,
        larkTaskGuid: body.larkTaskGuid ?? null,
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
    const where =
      q.role === 'approvals'
        ? { approverId: req.user.sub, ...(q.status ? { status: q.status } : {}) }
        : { userId: req.user.sub, ...(q.status ? { status: q.status } : {}) };
    const rows = await prisma.manualTimeRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { attendees: true },
    });
    res.json({ requests: rows.map(serialize) });
  } catch (err) {
    next(err);
  }
});

/**
 * Edit a still-PENDING request. Re-sends the updated approval card to the
 * approver and a tiny "Request updated" text nudge so they notice the change.
 * Both Lark calls are best-effort — they never block the DB write.
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
    if (existing.userId !== req.user.sub) return res.status(403).json({ error: 'forbidden' });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'immutable_after_decision', status: existing.status });

    const body = req.body as PatchBody;
    // Range sanity if both edges are touched (or one is touched + existing).
    const start = body.requestedStart ? new Date(body.requestedStart) : existing.requestedStart;
    const end = body.requestedEnd ? new Date(body.requestedEnd) : existing.requestedEnd;
    if (!(start.getTime() < end.getTime())) return res.status(400).json({ error: 'invalid_range' });

    // Validate attendees if present in the patch.
    let attendeeIds: string[] | null = null;
    if (body.attendeeIds !== undefined) {
      const check = await validateAttendees(req.user.ws, req.user.sub, body.attendeeIds);
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
      if ((existing.larkTaskGuid ?? null) !== (body.larkTaskGuid ?? existing.larkTaskGuid ?? null)) {
        diff.push({ label: 'Task', before: existing.larkTaskGuid ?? '—', after: body.larkTaskGuid ?? '—' });
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
            taskSummary: null,
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
            taskSummary: body.taskSummary ?? null,
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
 * Cancel a still-PENDING request. Marks status=CANCELLED, swaps the original
 * Lark card for a "cancelled" variant (no buttons) and pings the approver
 * with a one-line notice so an in-flight approver doesn't act on a dead
 * request. Decided requests are immutable (409).
 */
timeRequestsRouter.post('/:id/cancel', async (req, res, next) => {
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
    if (existing.userId !== req.user.sub) return res.status(403).json({ error: 'forbidden' });
    if (existing.status !== 'PENDING') return res.status(409).json({ error: 'immutable_after_decision', status: existing.status });

    const now = new Date();
    const updated = await prisma.manualTimeRequest.update({
      where: { id },
      data: { status: 'CANCELLED', decidedAt: now, decidedReason: 'Cancelled by requester' },
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
            taskSummary: null,
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
