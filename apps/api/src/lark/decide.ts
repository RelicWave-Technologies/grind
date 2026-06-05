import { prisma } from '@grind/db';
import { ulid } from 'ulid';
import { buildDecidedCard, type ApprovalAction } from './cards';
import { logger } from '../logger';

/**
 * Apply an approval decision to a manual-time request. Pure-ish: takes prisma
 * via the singleton (so tests run against the real test DB) and returns the
 * card payload that the Lark callback should respond with to update the card
 * in place.
 *
 * Invariants:
 *  - Idempotent: a second click on an already-decided card returns the same
 *    decided card without re-decision.
 *  - Authorization: the decider's open_id must match the request's approver's
 *    LarkIdentity. (Until M11 introduces team-scoped MANAGER, the approver is
 *    fixed at create time so this is exact.)
 *  - On APPROVE: a real TimeEntry(source=MANUAL) is created spanning the
 *    requested range with a single WORK segment, and linked via
 *    ManualTimeRequest.timeEntryId.
 */
export interface DecideResult {
  card: Record<string, unknown>;
  status: 'APPROVED' | 'REJECTED' | 'PENDING' | 'CANCELLED';
  timeEntryId: string | null;
  /** Reason the decision was a no-op (or null). For observability / tests. */
  noop: 'already_decided' | 'not_found' | 'forbidden' | 'cancelled' | null;
}

export async function decideRequest(args: {
  requestId: string;
  action: ApprovalAction;
  decidedByOpenId: string;
  now?: Date;
}): Promise<DecideResult | null> {
  const now = args.now ?? new Date();
  const req = await prisma.manualTimeRequest.findUnique({
    where: { id: args.requestId },
    include: {
      user: { select: { name: true } },
      approver: { include: { larkIdentity: { select: { openId: true } } } },
      attendees: { select: { userId: true } },
    },
  });
  if (!req) return null;

  // Authorization: the clicker must be the assigned approver.
  if (!req.approver?.larkIdentity?.openId || req.approver.larkIdentity.openId !== args.decidedByOpenId) {
    logger.warn({ requestId: req.id, decidedByOpenId: args.decidedByOpenId }, 'decideRequest: forbidden');
    return { card: {}, status: req.status, timeEntryId: req.timeEntryId, noop: 'forbidden' };
  }

  // Idempotent: already decided → return the existing decided card.
  if (req.status !== 'PENDING') {
    // CANCELLED is a special case: requester pulled the request before this
    // click landed. Return a "Request cancelled" card variant (red, no buttons,
    // no TimeEntry) so the approver knows their click was a no-op.
    if (req.status === 'CANCELLED') {
      return {
        card: buildDecidedCard({
          requestId: req.id,
          requesterName: req.user.name,
          taskSummary: null,
          startedAt: req.requestedStart.getTime(),
          endedAt: req.requestedEnd.getTime(),
          reason: req.reason,
          decision: 'REJECTED', // CANCELLED reuses the rejected card chrome (red, no buttons)
          decidedByName: req.user.name + ' (cancelled)',
          decidedAt: (req.decidedAt ?? now).getTime(),
        }),
        status: 'CANCELLED',
        timeEntryId: null,
        noop: 'cancelled',
      };
    }
    const card = buildDecidedCard({
      requestId: req.id,
      requesterName: req.user.name,
      taskSummary: null,
      startedAt: req.requestedStart.getTime(),
      endedAt: req.requestedEnd.getTime(),
      reason: req.reason,
      decision: req.status,
      decidedByName: req.approver?.name ?? 'Approver',
      decidedAt: (req.decidedAt ?? now).getTime(),
    });
    return { card, status: req.status, timeEntryId: req.timeEntryId, noop: 'already_decided' };
  }

  const decision = args.action === 'approve' ? 'APPROVED' : 'REJECTED';

  // Snapshot the requester's current shiftId — manual time inherits the
  // schedule context from the user's present assignment.
  const requesterShift = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { shiftId: true },
  });

  // Atomic: persist the decision, and on APPROVE also create the TimeEntry.
  const result = await prisma.$transaction(async (tx) => {
    let timeEntryId: string | null = null;
    if (decision === 'APPROVED') {
      const teId = ulid();
      const attendeeIds = req.attendees.map((a) => a.userId);
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
            create: [{ id: ulid(), kind: 'WORK', startedAt: req.requestedStart, endedAt: req.requestedEnd }],
          },
          // Carry meeting attendees onto the approved entry (parity with the
          // dashboard + auto-approve paths) — otherwise they're lost.
          attendees: attendeeIds.length ? { create: attendeeIds.map((userId) => ({ userId })) } : undefined,
        },
      });
      timeEntryId = teId;
    }
    const updated = await tx.manualTimeRequest.update({
      where: { id: req.id },
      data: { status: decision, decidedAt: now, timeEntryId },
    });
    return { updated, timeEntryId };
  });

  const card = buildDecidedCard({
    requestId: req.id,
    requesterName: req.user.name,
    taskSummary: null,
    startedAt: req.requestedStart.getTime(),
    endedAt: req.requestedEnd.getTime(),
    reason: req.reason,
    decision,
    decidedByName: req.approver.name,
    decidedAt: now.getTime(),
  });

  return { card, status: decision, timeEntryId: result.timeEntryId, noop: null };
}
