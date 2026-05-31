import { Router } from 'express';
import { prisma } from '@grind/db';
import {
  CreateManualTimeRequest,
  ListManualTimeRequestsQuery,
  type CreateManualTimeRequest as CreateBody,
  type ManualTimeRequestDto,
  type ListManualTimeRequestsQuery as ListQuery,
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
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
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

export default timeRequestsRouter;
