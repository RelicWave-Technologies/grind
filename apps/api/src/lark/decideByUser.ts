import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import { buildDecidedCard, type ApprovalAction } from './cards';
import { getLarkMessenger } from './index';
import { logger } from '../logger';

/**
 * Dashboard-side decision flow for a ManualTimeRequest. Parallel to
 * `decideRequest` (which is authorized by Lark open_id from a card callback),
 * but authorized by the caller's user.id with scope (resolved by attachScope
 * upstream). This is what /v1/admin/manual-time-requests/:id/decide calls.
 *
 * Invariants — same as the Lark path:
 *  - Idempotent: re-deciding an already-decided request is a no-op that
 *    returns the existing status.
 *  - On APPROVE: creates a TimeEntry(source=MANUAL) spanning the requested
 *    range with a single WORK segment, and links via timeEntryId.
 *  - Best-effort Lark card refresh if the request had a card sent — never
 *    blocks the DB write.
 *
 * Authorization: the caller MUST be in scope for the requester. The route
 * passes scope.userIds from attachScope; this function double-checks.
 */
export interface DecideByUserResult {
  status: 'APPROVED' | 'REJECTED' | 'PENDING' | 'CANCELLED';
  timeEntryId: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  noop: 'already_decided' | 'cancelled' | 'forbidden' | null;
}

export async function decideByUser(args: {
  requestId: string;
  action: ApprovalAction;
  /** The authenticated user making the decision. */
  deciderUserId: string;
  /** The visible userIds from attachScope. The requester MUST appear here. */
  scopeUserIds: string[];
  /** Optional approver note attached to the decision. */
  reason?: string;
  now?: Date;
}): Promise<DecideByUserResult | null> {
  const now = args.now ?? new Date();
  const req = await prisma.manualTimeRequest.findUnique({
    where: { id: args.requestId },
    include: {
      user: { select: { name: true } },
    },
  });
  if (!req) return null;

  // Scope check: the requester must be in the decider's visible set.
  if (!args.scopeUserIds.includes(req.userId)) {
    logger.warn(
      { requestId: req.id, deciderUserId: args.deciderUserId, requesterUserId: req.userId },
      'decideByUser: forbidden (requester not in scope)',
    );
    return {
      status: req.status,
      timeEntryId: req.timeEntryId,
      decidedAt: req.decidedAt ? req.decidedAt.toISOString() : null,
      decidedReason: req.decidedReason,
      noop: 'forbidden',
    };
  }

  // Idempotent: already-decided requests just echo back.
  if (req.status !== 'PENDING') {
    return {
      status: req.status,
      timeEntryId: req.timeEntryId,
      decidedAt: req.decidedAt ? req.decidedAt.toISOString() : null,
      decidedReason: req.decidedReason,
      noop: req.status === 'CANCELLED' ? 'cancelled' : 'already_decided',
    };
  }

  const decision: 'APPROVED' | 'REJECTED' = args.action === 'approve' ? 'APPROVED' : 'REJECTED';

  // Snapshot the requester's current shiftId on approve so /v1/me-today
  // reports the correct shift context for the new MANUAL entry.
  const requesterShift = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { shiftId: true },
  });

  const result = await prisma.$transaction(async (tx) => {
    let timeEntryId: string | null = null;
    if (decision === 'APPROVED') {
      const teId = ulid();
      await tx.timeEntry.create({
        data: {
          id: teId,
          clientUuid: `mtr-${req.id}`,
          userId: req.userId,
          larkTaskGuid: req.larkTaskGuid,
          source: 'MANUAL',
          startedAt: req.requestedStart,
          endedAt: req.requestedEnd,
          shiftIdAtStart: requesterShift?.shiftId ?? null,
          segments: {
            create: [
              { id: ulid(), kind: 'WORK', startedAt: req.requestedStart, endedAt: req.requestedEnd },
            ],
          },
        },
      });
      timeEntryId = teId;
    }
    const updated = await tx.manualTimeRequest.update({
      where: { id: req.id },
      data: {
        status: decision,
        decidedAt: now,
        decidedReason: args.reason ?? null,
        // The decider is now also the approver of record — overwrite the
        // create-time auto-pick. Some old rows may have approverId set to a
        // different user; that's fine, we just stamp the actual decider.
        approverId: args.deciderUserId,
        timeEntryId,
      },
    });
    return { updated, timeEntryId };
  });

  // Best-effort Lark card refresh: if a card was sent, flip it to the
  // decided variant so the Lark approver UI matches DB truth even if the
  // decision happened in the dashboard. Failure is non-fatal.
  if (req.larkMessageId) {
    const messenger = getLarkMessenger();
    if (messenger) {
      try {
        const decider = await prisma.user.findUnique({ where: { id: args.deciderUserId }, select: { name: true } });
        await messenger.updateCard(
          req.larkMessageId,
          buildDecidedCard({
            requestId: req.id,
            requesterName: req.user.name,
            taskSummary: null,
            startedAt: req.requestedStart.getTime(),
            endedAt: req.requestedEnd.getTime(),
            reason: req.reason,
            decision,
            decidedByName: decider?.name ?? 'Approver',
            decidedAt: now.getTime(),
          }),
        );
      } catch (err) {
        logger.warn({ err: String(err), requestId: req.id }, 'lark card refresh after dashboard decide failed (non-fatal)');
      }
    }
  }

  return {
    status: decision,
    timeEntryId: result.timeEntryId,
    decidedAt: now.toISOString(),
    decidedReason: result.updated.decidedReason,
    noop: null,
  };
}
