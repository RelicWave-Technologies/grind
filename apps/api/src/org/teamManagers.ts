import type { Prisma } from '@grind/db';
import { prisma } from '@grind/db';

type Tx = Prisma.TransactionClient;
type Role = 'ADMIN' | 'MANAGER' | 'MEMBER';

export type OrgMutationResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      teamId?: string;
      teamName?: string;
      managedTeamId?: string;
      managedTeamName?: string;
    };

export type TeamManagerUser = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: 'ADMIN' | 'MANAGER' | 'MEMBER';
  teamId: string | null;
};

export type TeamManagerAssignment = {
  id: string;
  teamId: string;
  userId: string;
  createdAt: Date;
  user: TeamManagerUser;
};

export function normalizeManagerIds(input: unknown): string[] {
  const raw =
    Array.isArray(input)
      ? input
      : typeof input === 'string'
        ? [input]
        : [];
  return [...new Set(raw.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean))];
}

export async function syncDerivedRole(tx: Tx, userId: string): Promise<void> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, teamId: true, managerId: true },
  });
  if (!user || user.role === 'ADMIN') return;

  const managesTeam = await tx.teamManager.findUnique({
    where: { userId },
    select: { id: true, teamId: true },
  });
  const nextRole: Role = managesTeam ? 'MANAGER' : 'MEMBER';
  const data: Prisma.UserUpdateInput = {};
  if (user.role !== nextRole) data.role = nextRole;
  if (user.managerId !== null) data.managerId = null;
  if (managesTeam && user.teamId !== managesTeam.teamId) data.team = { connect: { id: managesTeam.teamId } };
  if (Object.keys(data).length > 0) {
    await tx.user.update({ where: { id: userId }, data });
  }
}

export async function syncWorkspaceDerivedRoles(tx: Tx, workspaceId: string): Promise<void> {
  const users = await tx.user.findMany({
    where: { workspaceId, role: { not: 'ADMIN' } },
    select: { id: true },
  });
  for (const user of users) await syncDerivedRole(tx, user.id);
}

export async function assertTeamInWorkspace(tx: Tx, workspaceId: string, teamId: string) {
  const team = await tx.team.findFirst({
    where: { id: teamId, workspaceId },
    select: { id: true, workspaceId: true },
  });
  return team;
}

export async function assertManagerCandidate(tx: Tx, workspaceId: string, userId: string) {
  return tx.user.findFirst({
    where: {
      id: userId,
      workspaceId,
      deactivatedAt: null,
      provisioningStatus: 'ACTIVE',
    },
    select: {
      id: true,
      workspaceId: true,
      role: true,
      managedTeamAssignment: {
        select: { teamId: true, team: { select: { id: true, name: true } } },
      },
    },
  });
}

export async function addTeamManager(tx: Tx, args: {
  workspaceId: string;
  teamId: string;
  userId: string;
}): Promise<OrgMutationResult> {
  const team = await assertTeamInWorkspace(tx, args.workspaceId, args.teamId);
  if (!team) return { ok: false, error: 'team_not_found' };

  const user = await assertManagerCandidate(tx, args.workspaceId, args.userId);
  if (!user) return { ok: false, error: 'manager_unavailable' };
  const existingManagedTeam = user.managedTeamAssignment?.team;
  if (existingManagedTeam && existingManagedTeam.id !== args.teamId) {
    return {
      ok: false,
      error: 'manager_already_assigned',
      teamId: existingManagedTeam.id,
      teamName: existingManagedTeam.name,
    };
  }

  await tx.teamManager.upsert({
    where: { teamId_userId: { teamId: args.teamId, userId: args.userId } },
    update: {},
    create: { workspaceId: args.workspaceId, teamId: args.teamId, userId: args.userId },
  });
  await syncDerivedRole(tx, args.userId);
  return { ok: true };
}

export async function removeTeamManager(tx: Tx, args: {
  workspaceId: string;
  teamId: string;
  userId: string;
}): Promise<OrgMutationResult> {
  const team = await assertTeamInWorkspace(tx, args.workspaceId, args.teamId);
  if (!team) return { ok: false, error: 'team_not_found' };
  await tx.teamManager.deleteMany({
    where: { workspaceId: args.workspaceId, teamId: args.teamId, userId: args.userId },
  });
  await syncDerivedRole(tx, args.userId);
  return { ok: true };
}

export async function replaceTeamManagers(tx: Tx, args: {
  workspaceId: string;
  teamId: string;
  managerIds: string[];
}): Promise<OrgMutationResult> {
  const team = await assertTeamInWorkspace(tx, args.workspaceId, args.teamId);
  if (!team) return { ok: false, error: 'team_not_found' };

  const existing = await tx.teamManager.findMany({
    where: { teamId: args.teamId },
    select: { userId: true },
  });
  const previousIds = new Set(existing.map((row) => row.userId));
  const nextIds = new Set(args.managerIds);
  const toRemove = [...previousIds].filter((id) => !nextIds.has(id));
  const toAdd = [...nextIds].filter((id) => !previousIds.has(id));

  for (const userId of toRemove) {
    await tx.teamManager.deleteMany({
      where: { workspaceId: args.workspaceId, teamId: args.teamId, userId },
    });
  }
  for (const userId of toAdd) {
    const added = await addTeamManager(tx, { workspaceId: args.workspaceId, teamId: args.teamId, userId });
    if (!added.ok) return added;
  }
  for (const userId of toRemove) {
    await syncDerivedRole(tx, userId);
  }
  return { ok: true };
}

export async function assignUserToTeam(tx: Tx, args: {
  workspaceId: string;
  userId: string;
  teamId: string | null;
  roleOverride?: Role;
}): Promise<OrgMutationResult> {
  const user = await tx.user.findFirst({
    where: { id: args.userId, workspaceId: args.workspaceId },
    select: {
      id: true,
      role: true,
      managedTeamAssignment: {
        select: { teamId: true, team: { select: { id: true, name: true } } },
      },
    },
  });
  if (!user) return { ok: false, error: 'user_not_found' };

  if (args.teamId !== null) {
    const team = await assertTeamInWorkspace(tx, args.workspaceId, args.teamId);
    if (!team) return { ok: false, error: 'team_out_of_workspace' };
  }

  const effectiveRole = args.roleOverride ?? user.role;
  const managedTeam = user.managedTeamAssignment?.team;
  if (effectiveRole !== 'ADMIN' && managedTeam && args.teamId !== managedTeam.id) {
    return {
      ok: false,
      error: 'managed_user_team_locked',
      managedTeamId: managedTeam.id,
      managedTeamName: managedTeam.name,
    };
  }

  await tx.user.update({
    where: { id: args.userId },
    data: { teamId: args.teamId },
  });
  return { ok: true };
}

export async function deleteTeam(tx: Tx, args: {
  workspaceId: string;
  teamId: string;
}): Promise<OrgMutationResult> {
  const team = await assertTeamInWorkspace(tx, args.workspaceId, args.teamId);
  if (!team) return { ok: false, error: 'team_not_found' };

  const managers = await tx.teamManager.findMany({
    where: { workspaceId: args.workspaceId, teamId: args.teamId },
    select: { userId: true },
  });
  await tx.team.delete({ where: { id: args.teamId } });
  for (const manager of managers) {
    await syncDerivedRole(tx, manager.userId);
  }
  return { ok: true };
}

export async function managedTeamIdsForUser(userId: string): Promise<string[]> {
  const assignment = await prisma.teamManager.findUnique({
    where: { userId },
    select: { teamId: true },
  });
  return assignment ? [assignment.teamId] : [];
}

export async function activeManagersForHomeTeam(workspaceId: string, teamId: string, excludeUserId?: string): Promise<Array<{
  id: string;
  name: string;
  larkIdentity: { openId: string } | null;
}>> {
  const rows = await prisma.teamManager.findMany({
    where: {
      workspaceId,
      teamId,
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
      user: {
        deactivatedAt: null,
        provisioningStatus: 'ACTIVE',
        role: { in: ['MANAGER', 'ADMIN'] },
      },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      user: {
        select: {
          id: true,
          name: true,
          larkIdentity: { select: { openId: true } },
        },
      },
    },
  });
  return rows.map((row) => row.user);
}
