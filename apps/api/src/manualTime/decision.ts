import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import {
  buildCancelledCard,
  buildDecidedCard,
  buildStaleRequestCard,
  type ApprovalAction,
} from '../lark/cards';
import { logger } from '../logger';
import { queueManualTimeApprovalCard, queueManualTimeFinalizeCards } from './larkOutbox';

type ManualTimeStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
type ManualTimeNoop =
  | 'already_decided'
  | 'cancelled'
  | 'not_found'
  | 'forbidden'
  | 'self_approval_forbidden'
  | 'stale_card'
  | null;
type DecisionSource = 'LARK_CARD' | 'DASHBOARD';

export interface ManualTimeDecisionResult {
  card: Record<string, unknown>;
  status: ManualTimeStatus;
  timeEntryId: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  noop: ManualTimeNoop;
}

function canSelfApproveManualTime(role: string): boolean {
  return role === 'ADMIN' || role === 'MANAGER';
}

function finalCard(req: {
  id: string;
  taskSummary: string | null;
  requestedStart: Date;
  requestedEnd: Date;
  reason: string;
  status: ManualTimeStatus;
  decidedAt: Date | null;
  user: { name: string };
  approver: { name: string } | null;
}, now: Date): Record<string, unknown> {
  const common = {
    requestId: req.id,
    requesterName: req.user.name,
    taskSummary: req.taskSummary,
    startedAt: req.requestedStart.getTime(),
    endedAt: req.requestedEnd.getTime(),
    reason: req.reason,
  };
  if (req.status === 'CANCELLED') {
    return buildCancelledCard({
      ...common,
      cancelledAt: (req.decidedAt ?? now).getTime(),
    });
  }
  return buildDecidedCard({
    ...common,
    decision: req.status === 'REJECTED' ? 'REJECTED' : 'APPROVED',
    decidedByName: req.approver?.name ?? 'Approver',
    decidedAt: (req.decidedAt ?? now).getTime(),
  });
}

export async function decideManualTimeRequest(args: {
  requestId: string;
  action: ApprovalAction;
  source: DecisionSource;
  decidedByOpenId?: string;
  deciderUserId?: string;
  deciderRole?: string;
  scopeUserIds?: string[];
  cardId?: string;
  version?: number;
  reason?: string;
  now?: Date;
}): Promise<ManualTimeDecisionResult | null> {
  const now = args.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ManualTimeRequest" WHERE id = ${args.requestId} FOR UPDATE
    `;
    if (locked.length === 0) {
      logger.warn({ requestId: args.requestId, action: args.action, source: args.source }, 'manualTimeDecision: not found');
      return null;
    }

    const req = await tx.manualTimeRequest.findUniqueOrThrow({
      where: { id: args.requestId },
      include: {
        user: { select: { name: true, larkIdentity: { select: { openId: true } } } },
        approver: { include: { larkIdentity: { select: { openId: true } } } },
        attendees: { select: { userId: true } },
      },
    });

    if (args.source === 'DASHBOARD') {
      if (!args.deciderUserId || !args.deciderRole || !args.scopeUserIds?.includes(req.userId)) {
        logger.warn({ requestId: req.id, deciderUserId: args.deciderUserId, requesterUserId: req.userId }, 'manualTimeDecision: dashboard forbidden');
        return {
          card: {},
          status: req.status,
          timeEntryId: req.timeEntryId,
          decidedAt: req.decidedAt ? req.decidedAt.toISOString() : null,
          decidedReason: req.decidedReason,
          noop: 'forbidden',
        };
      }
      if (req.status === 'PENDING' && req.userId === args.deciderUserId && !canSelfApproveManualTime(args.deciderRole)) {
        return {
          card: {},
          status: req.status,
          timeEntryId: req.timeEntryId,
          decidedAt: req.decidedAt ? req.decidedAt.toISOString() : null,
          decidedReason: req.decidedReason,
          noop: 'self_approval_forbidden',
        };
      }
    } else {
      if (!req.approver?.larkIdentity?.openId || req.approver.larkIdentity.openId !== args.decidedByOpenId) {
        logger.warn({ requestId: req.id, decidedByOpenId: args.decidedByOpenId }, 'manualTimeDecision: lark forbidden');
        return {
          card: {},
          status: req.status,
          timeEntryId: req.timeEntryId,
          decidedAt: req.decidedAt ? req.decidedAt.toISOString() : null,
          decidedReason: req.decidedReason,
          noop: 'forbidden',
        };
      }
      if (req.status === 'PENDING' && req.approverId === req.userId && !canSelfApproveManualTime(req.approver.role)) {
        return {
          card: {},
          status: req.status,
          timeEntryId: req.timeEntryId,
          decidedAt: req.decidedAt ? req.decidedAt.toISOString() : null,
          decidedReason: req.decidedReason,
          noop: 'self_approval_forbidden',
        };
      }
    }

    if (req.status !== 'PENDING') {
      return {
        card: finalCard(req, now),
        status: req.status,
        timeEntryId: req.timeEntryId,
        decidedAt: req.decidedAt ? req.decidedAt.toISOString() : null,
        decidedReason: req.decidedReason,
        noop: req.status === 'CANCELLED' ? 'cancelled' : 'already_decided',
      };
    }

    if (args.source === 'LARK_CARD') {
      const card =
        args.cardId
          ? await tx.manualTimeLarkMessage.findUnique({ where: { id: args.cardId } })
          : null;
      const stale =
        !card ||
        card.requestId !== req.id ||
        card.version !== req.version ||
        args.version !== req.version;
      if (stale) {
        if (card && card.requestId === req.id) {
          await tx.manualTimeLarkMessage.update({
            where: { id: card.id },
            data: { status: 'STALE' },
          });
        }
        return {
          card: buildStaleRequestCard({ requestId: req.id, version: args.version ?? null, currentVersion: req.version }),
          status: req.status,
          timeEntryId: req.timeEntryId,
          decidedAt: null,
          decidedReason: null,
          noop: 'stale_card',
        };
      }
    }

    const decision: 'APPROVED' | 'REJECTED' = args.action === 'approve' ? 'APPROVED' : 'REJECTED';
    const requesterShift = await tx.user.findUnique({ where: { id: req.userId }, select: { shiftId: true } });
    let timeEntryId: string | null = null;
    if (decision === 'APPROVED') {
      const clientUuid = `mtr-${req.id}`;
      const existingEntry = await tx.timeEntry.findUnique({ where: { clientUuid }, select: { id: true } });
      if (existingEntry) {
        timeEntryId = existingEntry.id;
      } else {
        const teId = ulid();
        const attendeeIds = req.attendees.map((a) => a.userId);
        await tx.timeEntry.create({
          data: {
            id: teId,
            clientUuid,
            userId: req.userId,
            larkTaskGuid: req.larkTaskGuid,
            source: 'MANUAL',
            startedAt: req.requestedStart,
            endedAt: req.requestedEnd,
            shiftIdAtStart: requesterShift?.shiftId ?? null,
            segments: {
              create: [{ id: ulid(), kind: 'WORK', startedAt: req.requestedStart, endedAt: req.requestedEnd }],
            },
            attendees: attendeeIds.length ? { create: attendeeIds.map((userId) => ({ userId })) } : undefined,
          },
        });
        timeEntryId = teId;
      }
    }

    const updated = await tx.manualTimeRequest.update({
      where: { id: req.id },
      data: {
        status: decision,
        version: { increment: 1 },
        decidedAt: now,
        decidedReason: args.reason ?? null,
        decidedById: args.source === 'DASHBOARD' ? args.deciderUserId ?? null : req.approverId,
        decisionSource: args.source,
        approverId: args.source === 'DASHBOARD' ? args.deciderUserId ?? req.approverId : req.approverId,
        timeEntryId,
      },
      include: {
        user: { select: { name: true } },
        approver: { select: { name: true } },
      },
    });
    await queueManualTimeFinalizeCards(tx, req.id);
    const requesterOpenId = req.user.larkIdentity?.openId ?? null;
    const requesterMadeDecision =
      args.source === 'DASHBOARD'
        ? req.userId === args.deciderUserId
        : requesterOpenId !== null && requesterOpenId === args.decidedByOpenId;
    if (requesterOpenId && !requesterMadeDecision) {
      await queueManualTimeApprovalCard(tx, {
        requestId: req.id,
        version: updated.version,
        recipientOpenId: requesterOpenId,
        kind: 'DECIDED_NOTICE',
      });
    }

    return {
      card: finalCard(updated, now),
      status: decision,
      timeEntryId,
      decidedAt: now.toISOString(),
      decidedReason: updated.decidedReason,
      noop: null,
    };
  });
}

export async function cancelManualTimeRequest(args: {
  requestId: string;
  actorUserId: string;
  reason: string;
  source: 'REQUESTER_CANCEL' | 'MANAGER_CANCEL';
  now?: Date;
}): Promise<{ status: ManualTimeStatus; decidedAt: Date; decidedReason: string } | null> {
  const now = args.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ManualTimeRequest" WHERE id = ${args.requestId} FOR UPDATE
    `;
    if (locked.length === 0) return null;
    const req = await tx.manualTimeRequest.findUniqueOrThrow({ where: { id: args.requestId } });
    if (req.status !== 'PENDING') {
      return { status: req.status, decidedAt: req.decidedAt ?? now, decidedReason: req.decidedReason ?? '' };
    }
    await tx.manualTimeRequest.update({
      where: { id: req.id },
      data: {
        status: 'CANCELLED',
        version: { increment: 1 },
        decidedAt: now,
        decidedReason: args.reason,
        decidedById: args.actorUserId,
        decisionSource: args.source,
      },
    });
    await queueManualTimeFinalizeCards(tx, req.id);
    return { status: 'CANCELLED', decidedAt: now, decidedReason: args.reason };
  });
}
