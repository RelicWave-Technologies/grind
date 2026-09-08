import { prisma, type Prisma } from '@grind/db';

/**
 * Permanently delete one member and everything that belongs to them.
 *
 * Deactivation is the everyday answer — it keeps the history and the reports
 * intact. This is the other one: the person and their record are gone, and
 * there is no undo. Production has no backups, so the shape of the destruction
 * is computed and returned BEFORE anything is written, and the caller is
 * expected to show it to a human first.
 *
 * ## Why this is a routine and not a pile of schema cascades
 *
 * Six relations into `User` carry no `onDelete`, which in Prisma means
 * `Restrict` — `user.delete()` fails on them today. The obvious fix, marking
 * them all `Cascade`, is wrong for one of them: `ManualTimeRequest.approverId`
 * points at the person who APPROVED a request, not the person who made it.
 * Cascading that would delete other people's approved time because their
 * approver left. It is nulled instead.
 *
 * Writing the order out here also makes it reviewable. A cascade is invisible
 * at the call site; this is a list somebody can read and argue with.
 *
 * ## What survives
 *
 * Twelve relations are `SetNull`, so the records this person touched on
 * someone else's behalf stay, minus the name: leave they decided, flags they
 * resolved, holidays they created, corrections they made. That is deliberate —
 * deleting a leaver must not rewrite everybody else's history.
 *
 * ## What this does NOT do
 *
 * Screenshot rows cascade, but the image files behind them (`s3Key`,
 * `thumbS3Key`) are not touched. The count and the keys come back in the
 * result so the caller can log them; deleting the objects themselves is a
 * separate job with its own failure modes.
 */

export interface MemberDeletionPlan {
  userId: string;
  name: string;
  email: string;
  /** Rows that will be destroyed, by what they are. */
  destroys: {
    timeEntries: number;
    activitySamples: number;
    screenshots: number;
    manualTimeRequests: number;
    activityFlags: number;
    leaveRequests: number;
    leaveLedgerEntries: number;
    attendancePunches: number;
    attendanceOverrides: number;
    sessions: number;
  };
  /** Rows kept, with this person's name removed from them. */
  anonymises: {
    manualTimeRequestsTheyApproved: number;
  };
  /**
   * Screenshot objects that will be left in storage with nothing pointing at
   * them. Reported rather than silently orphaned.
   */
  orphanedScreenshotFiles: number;
}

export type DeletionRefusal =
  | 'not_found'
  | 'cannot_delete_self'
  | 'last_admin_protected'
  | 'remove_team_manager_first';

export async function planMemberDeletion(input: {
  workspaceId: string;
  userId: string;
  actorId: string;
}): Promise<{ ok: true; plan: MemberDeletionPlan } | { ok: false; error: DeletionRefusal; teamName?: string }> {
  const { workspaceId, userId } = input;

  if (userId === input.actorId) return { ok: false, error: 'cannot_delete_self' };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, workspaceId: true },
  });
  if (!user || user.workspaceId !== workspaceId) return { ok: false, error: 'not_found' };

  // Mirrors the deactivate path: the workspace must never lose its last admin,
  // and a team must never lose its manager silently.
  if (user.role === 'ADMIN') {
    const admins = await prisma.user.count({
      where: { workspaceId, role: 'ADMIN', deactivatedAt: null, id: { not: userId } },
    });
    if (admins === 0) return { ok: false, error: 'last_admin_protected' };
  }
  const managed = await prisma.teamManager.findUnique({
    where: { userId },
    select: { team: { select: { name: true } } },
  });
  if (managed) return { ok: false, error: 'remove_team_manager_first', teamName: managed.team.name };

  const [
    timeEntries, activitySamples, screenshots, manualTimeRequests, activityFlags,
    leaveRequests, leaveLedgerEntries, attendancePunches, attendanceOverrides, sessions,
    approvedForOthers, screenshotsWithFiles,
  ] = await Promise.all([
    prisma.timeEntry.count({ where: { userId } }),
    prisma.activitySample.count({ where: { userId } }),
    prisma.screenshot.count({ where: { userId } }),
    prisma.manualTimeRequest.count({ where: { userId } }),
    prisma.activityFlag.count({ where: { userId } }),
    prisma.leaveRequest.count({ where: { userId } }),
    prisma.leaveLedgerEntry.count({ where: { userId } }),
    prisma.attendancePunch.count({ where: { userId } }),
    prisma.attendanceOverride.count({ where: { userId } }),
    prisma.refreshToken.count({ where: { userId, revokedAt: null } }),
    prisma.manualTimeRequest.count({ where: { approverId: userId, userId: { not: userId } } }),
    prisma.screenshot.count({ where: { userId, OR: [{ s3Key: { not: null } }, { thumbS3Key: { not: null } }] } }),
  ]);

  return {
    ok: true,
    plan: {
      userId: user.id,
      name: user.name,
      email: user.email,
      destroys: {
        timeEntries, activitySamples, screenshots, manualTimeRequests, activityFlags,
        leaveRequests, leaveLedgerEntries, attendancePunches, attendanceOverrides, sessions,
      },
      anonymises: { manualTimeRequestsTheyApproved: approvedForOthers },
      orphanedScreenshotFiles: screenshotsWithFiles,
    },
  };
}

/**
 * Do it.
 *
 * One transaction, children before parents. The order is load-bearing: the six
 * `Restrict` relations each block `user.delete()` until their rows are gone,
 * and `approverId` has to be nulled rather than followed.
 */
export async function deleteMember(input: {
  workspaceId: string;
  userId: string;
  actorId: string;
}): Promise<{ ok: true; plan: MemberDeletionPlan } | { ok: false; error: DeletionRefusal; teamName?: string }> {
  const planned = await planMemberDeletion(input);
  if (!planned.ok) return planned;

  const { userId } = input;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Other people's requests that this person approved. Nulling first, because
    // `approverId` is Restrict and would otherwise block the delete — and
    // because those requests belong to their requesters, not to the approver.
    await tx.manualTimeRequest.updateMany({
      where: { approverId: userId, userId: { not: userId } },
      data: { approverId: null },
    });

    // Their own requests. Lark messages, outbox events and attendees hang off
    // these with Cascade, so they go too.
    await tx.manualTimeRequest.deleteMany({ where: { userId } });

    await tx.activitySample.deleteMany({ where: { userId } });
    await tx.activityFlag.deleteMany({ where: { userId } });
    await tx.refreshToken.deleteMany({ where: { userId } });

    // Segments and attendees cascade off the entries; screenshots and any
    // remaining samples have their `timeEntryId` nulled rather than following.
    await tx.timeEntry.deleteMany({ where: { userId } });

    // Everything left is either Cascade (screenshots, leave, punches, shifts,
    // Lark identity, API tokens) or SetNull (the audit trail), so the row can
    // finally go.
    await tx.user.delete({ where: { id: userId } });
  });

  return planned;
}
