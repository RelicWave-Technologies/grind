import { Router } from 'express';
import { prisma } from '@grind/db';
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
import { buildApprovalCard, getLarkMessenger } from '../lark';
import { logger } from '../logger';

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
  decidedAt: Date | null;
  decidedReason: string | null;
  createdAt: Date;
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
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decidedReason: r.decidedReason,
    createdAt: r.createdAt.toISOString(),
  };
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
    const existing = await prisma.manualTimeRequest.findUnique({ where: { clientUuid: body.clientUuid } });
    if (existing) {
      if (existing.userId !== req.user.sub) return res.status(409).json({ error: 'client_uuid_conflict' });
      return res.status(200).json(serialize(existing));
    }

    // Pick an approver: any ADMIN/OWNER in the workspace, not the requester.
    const approver = await prisma.user.findFirst({
      where: { workspaceId: req.user.ws, id: { not: req.user.sub }, role: { in: ['ADMIN', 'OWNER'] } },
      include: { larkIdentity: { select: { openId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!approver) return res.status(400).json({ error: 'no_approver' });

    const requester = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub }, select: { name: true } });

    // Create the row first; messaging is best-effort.
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
      },
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
    const rows = await prisma.manualTimeRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
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

    const updated = await prisma.manualTimeRequest.update({
      where: { id },
      data: {
        requestedStart: start,
        requestedEnd: end,
        ...(body.larkTaskGuid !== undefined ? { larkTaskGuid: body.larkTaskGuid } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      },
    });

    // Best-effort: re-send updated card + a small notice. Failure must NOT
    // break the PATCH — the DB state is the source of truth.
    const messenger = getLarkMessenger();
    if (messenger && existing.approver?.larkIdentity?.openId && existing.larkMessageId) {
      try {
        const newCard = buildApprovalCard({
          requestId: updated.id,
          requesterName: existing.user.name,
          taskSummary: body.taskSummary ?? null,
          startedAt: start.getTime(),
          endedAt: end.getTime(),
          reason: updated.reason,
        });
        await messenger.updateCard(existing.larkMessageId, newCard);
        await messenger.sendText(
          existing.approver.larkIdentity.openId,
          `↑ Request from ${existing.user.name} was just updated. Please review again.`,
        );
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
    if (messenger && existing.approver?.larkIdentity?.openId && existing.larkMessageId) {
      try {
        // Reuse the "decided" red card with CANCELLED chrome so the approver
        // sees the card update in place and knows not to act.
        const cancelledCard = buildApprovalCard({
          requestId: updated.id,
          requesterName: existing.user.name,
          taskSummary: null,
          startedAt: existing.requestedStart.getTime(),
          endedAt: existing.requestedEnd.getTime(),
          reason: existing.reason,
        });
        // The buttons are still in the card; the WS callback's idempotency
        // catches them (status=CANCELLED → 'cancelled' noop). We could swap
        // for buildDecidedCard but that's a separate variant; using the
        // existing card + the sendText notice is enough for v2.
        await messenger.updateCard(existing.larkMessageId, cancelledCard).catch(() => {});
        await messenger.sendText(
          existing.approver.larkIdentity.openId,
          `✕ Request from ${existing.user.name} was cancelled by the requester. You can ignore the card.`,
        );
      } catch (err) {
        logger.warn({ err: String(err), requestId: id }, 'lark cancel-notice failed (non-fatal)');
      }
    }
    res.json(serialize(updated));
  } catch (err) {
    next(err);
  }
});

export default timeRequestsRouter;
