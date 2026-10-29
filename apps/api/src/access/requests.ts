import { prisma, type Prisma } from '@grind/db';
import { assignUserToTeam } from '../org/teamManagers';
import {
  buildDecidedAccessCard,
  buildUnavailableAccessCard,
  type AccessCardAction,
} from '../lark/accessCards';

/**
 * Access requests: a person's first Lark login lands them PENDING, and the
 * workspace admins (or the ones chosen in Policy) get a Lark card to let them
 * in. The AccessRequest row is the audit trail — who decided, when, from
 * where, with which team and shift — whether the decision came from the card
 * or from the dashboard.
 */

type Tx = Prisma.TransactionClient;

/** Open a request for a just-created PENDING user and queue the cards. */
export async function openAccessRequest(tx: Tx, userId: string): Promise<void> {
  const request = await tx.accessRequest.create({ data: { userId } });
  await tx.accessRequestLarkOutboxEvent.create({
    data: { accessRequestId: request.id, kind: 'SEND_CARDS' },
  });
}

/**
 * The dashboard activated (or deactivated) someone who was waiting: close
 * their request and rewrite the admins' cards. No-op when there is no open
 * request, so callers can call it on every activation path.
 */
export async function settleAccessRequestFromDashboard(
  tx: Tx,
  args: { userId: string; decision: 'APPROVED' | 'REJECTED'; decidedById: string | null; now?: Date },
): Promise<void> {
  const open = await tx.accessRequest.findUnique({
    where: { userId: args.userId },
    select: { id: true, status: true },
  });
  if (!open || open.status !== 'PENDING') return;
  const closed = await tx.accessRequest.updateMany({
    where: { id: open.id, status: 'PENDING' },
    data: {
      status: args.decision,
      decidedVia: 'DASHBOARD',
      decidedById: args.decidedById,
      decidedAt: args.now ?? new Date(),
    },
  });
  if (closed.count === 1) {
    await tx.accessRequestLarkOutboxEvent.create({
      data: { accessRequestId: open.id, kind: 'FINALIZE_CARDS' },
    });
  }
}

/**
 * Who gets the card: the admins picked in Policy, or every active admin when
 * none are picked (or none of the picked ones can still decide). Only people
 * with a Lark identity can receive one.
 */
export async function resolveAccessRequestRecipients(workspaceId: string): Promise<Array<{ userId: string; openId: string }>> {
  const [policy, admins] = await Promise.all([
    prisma.workspacePolicy.findUnique({ where: { workspaceId }, select: { accessRequestRecipientIds: true } }),
    prisma.user.findMany({
      where: { workspaceId, role: 'ADMIN', provisioningStatus: 'ACTIVE', deactivatedAt: null },
      select: { id: true, larkIdentity: { select: { openId: true } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  const chosen = new Set(policy?.accessRequestRecipientIds ?? []);
  const picked = admins.filter((a) => chosen.has(a.id));
  const pool = picked.length > 0 ? picked : admins;
  return pool.flatMap((a) => (a.larkIdentity ? [{ userId: a.id, openId: a.larkIdentity.openId }] : []));
}

/** Everything a card needs, in the request's current state. */
export async function loadAccessCardState(accessRequestId: string) {
  const req = await prisma.accessRequest.findUnique({
    where: { id: accessRequestId },
    include: {
      user: { select: { name: true, email: true, workspaceId: true, workspace: { select: { timezone: true } } } },
      decidedBy: { select: { name: true } },
    },
  });
  if (!req) return null;
  const [team, shift] = await Promise.all([
    req.teamId ? prisma.team.findUnique({ where: { id: req.teamId }, select: { name: true } }) : null,
    req.shiftId ? prisma.shift.findUnique({ where: { id: req.shiftId }, select: { name: true } }) : null,
  ]);
  return { req, teamName: team?.name ?? null, shiftName: shift?.name ?? null };
}

export function decidedCardFor(state: NonNullable<Awaited<ReturnType<typeof loadAccessCardState>>>): Record<string, unknown> {
  const { req } = state;
  return buildDecidedAccessCard({
    accessRequestId: req.id,
    name: req.user.name,
    email: req.user.email,
    requestedAt: req.createdAt.getTime(),
    timeZone: req.user.workspace.timezone,
    decision: req.status === 'REJECTED' ? 'REJECTED' : 'APPROVED',
    via: req.decidedVia ?? 'DASHBOARD',
    decidedByName: req.decidedBy?.name ?? null,
    decidedAt: (req.decidedAt ?? req.updatedAt).getTime(),
    teamName: state.teamName,
    shiftName: state.shiftName,
  });
}

export type AccessDecisionOutcome =
  | { ok: true; status: 'APPROVED' | 'REJECTED'; card: Record<string, unknown>; alreadyDecided: boolean }
  | { ok: false; error: 'not_found'; card: Record<string, unknown> }
  | { ok: false; error: 'forbidden' | 'team_required' | 'shift_required' | 'team_invalid' | 'shift_invalid' | 'team_locked' };

class DecisionRejected extends Error {
  constructor(readonly code: 'team_invalid' | 'shift_invalid' | 'team_locked') {
    super(code);
  }
}

/**
 * An admin clicked Approve or Reject on a card. Approve activates the person
 * exactly like the dashboard does (team via assignUserToTeam, a ShiftAssignment
 * row for the shift, provisioningStatus ACTIVE); Reject deactivates them like
 * the dashboard's Deactivate. The row lock makes a double click, or two admins
 * at once, decide only once — the loser gets the decided card back.
 */
export async function decideAccessRequestFromLark(args: {
  accessRequestId: string;
  action: AccessCardAction;
  decidedByOpenId: string;
  teamId?: string | null;
  shiftId?: string | null;
  now?: Date;
}): Promise<AccessDecisionOutcome> {
  const now = args.now ?? new Date();
  const identity = await prisma.larkIdentity.findUnique({
    where: { openId: args.decidedByOpenId },
    select: { user: { select: { id: true, role: true, workspaceId: true, provisioningStatus: true, deactivatedAt: true } } },
  });
  const decider = identity?.user;
  if (!decider || decider.role !== 'ADMIN' || decider.provisioningStatus !== 'ACTIVE' || decider.deactivatedAt) {
    return { ok: false, error: 'forbidden' };
  }

  // Checked before the transaction so a missing pick never takes the lock.
  if (args.action === 'approve' && !args.teamId) return { ok: false, error: 'team_required' };
  if (args.action === 'approve' && !args.shiftId) return { ok: false, error: 'shift_required' };

  let result: { status: 'APPROVED' | 'REJECTED'; alreadyDecided: boolean } | 'not_found' | 'forbidden';
  try {
    result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AccessRequest" WHERE id = ${args.accessRequestId} FOR UPDATE`;
      const req = await tx.accessRequest.findUnique({
        where: { id: args.accessRequestId },
        include: { user: { select: { id: true, workspaceId: true, provisioningStatus: true, deactivatedAt: true } } },
      });
      if (!req) return 'not_found' as const;
      if (req.user.workspaceId !== decider.workspaceId) return 'forbidden' as const;
      if (req.status !== 'PENDING') {
        return { status: req.status, alreadyDecided: true };
      }

      // Settled outside the hooks (shouldn't happen): record what the dashboard did.
      const settledElsewhere = req.user.deactivatedAt ? 'REJECTED' : req.user.provisioningStatus === 'ACTIVE' ? 'APPROVED' : null;
      if (settledElsewhere) {
        await tx.accessRequest.update({
          where: { id: req.id },
          data: { status: settledElsewhere, decidedVia: 'DASHBOARD', decidedAt: now },
        });
        await tx.accessRequestLarkOutboxEvent.create({ data: { accessRequestId: req.id, kind: 'FINALIZE_CARDS' } });
        return { status: settledElsewhere, alreadyDecided: true };
      }

      if (args.action === 'reject') {
        await tx.user.update({ where: { id: req.userId }, data: { deactivatedAt: now } });
        await tx.refreshToken.updateMany({ where: { userId: req.userId, revokedAt: null }, data: { revokedAt: now } });
        await tx.accessRequest.update({
          where: { id: req.id },
          data: { status: 'REJECTED', decidedVia: 'LARK_CARD', decidedById: decider.id, decidedAt: now },
        });
      } else {
        const shift = await tx.shift.findUnique({
          where: { id: args.shiftId! },
          select: { workspaceId: true, name: true, schedule: true, bufferMin: true },
        });
        if (!shift || shift.workspaceId !== decider.workspaceId) throw new DecisionRejected('shift_invalid');
        const assigned = await assignUserToTeam(tx, {
          workspaceId: decider.workspaceId,
          userId: req.userId,
          teamId: args.teamId!,
        });
        if (!assigned.ok) {
          throw new DecisionRejected(assigned.error === 'managed_user_team_locked' ? 'team_locked' : 'team_invalid');
        }
        await tx.shiftAssignment.updateMany({
          where: { userId: req.userId, effectiveTo: null },
          data: { effectiveTo: now },
        });
        await tx.shiftAssignment.create({
          data: {
            userId: req.userId,
            shiftId: args.shiftId!,
            effectiveFrom: now,
            shiftNameSnapshot: shift.name,
            bufferMinSnapshot: shift.bufferMin,
            scheduleSnapshot: shift.schedule as Prisma.InputJsonValue,
          },
        });
        await tx.user.update({
          where: { id: req.userId },
          data: { shiftId: args.shiftId!, shiftAssignedAt: now, provisioningStatus: 'ACTIVE' },
        });
        await tx.accessRequest.update({
          where: { id: req.id },
          data: {
            status: 'APPROVED',
            decidedVia: 'LARK_CARD',
            decidedById: decider.id,
            decidedAt: now,
            teamId: args.teamId!,
            shiftId: args.shiftId!,
          },
        });
      }
      await tx.accessRequestLarkOutboxEvent.create({ data: { accessRequestId: req.id, kind: 'FINALIZE_CARDS' } });
      return { status: args.action === 'reject' ? 'REJECTED' as const : 'APPROVED' as const, alreadyDecided: false };
    });
  } catch (err) {
    if (err instanceof DecisionRejected) {
      return { ok: false, error: err.code };
    }
    throw err;
  }

  if (result === 'not_found') return { ok: false, error: 'not_found', card: buildUnavailableAccessCard() };
  if (result === 'forbidden') return { ok: false, error: 'forbidden' };
  const state = await loadAccessCardState(args.accessRequestId);
  if (!state) return { ok: false, error: 'not_found', card: buildUnavailableAccessCard() };
  return { ok: true, status: result.status, alreadyDecided: result.alreadyDecided, card: decidedCardFor(state) };
}
