import { prisma } from '@grind/db';
import {
  Role as RoleSchema,
  WORKSPACE_POLICY_DEFAULTS,
  type SelfProfileResponse,
} from '@grind/types';

async function loadOrCreatePolicy(workspaceId: string) {
  const existing = await prisma.workspacePolicy.findUnique({ where: { workspaceId } });
  if (existing) return existing;
  return prisma.workspacePolicy.create({
    data: { workspaceId, ...WORKSPACE_POLICY_DEFAULTS },
  });
}

export async function loadProfileForUser(
  userId: string,
  workspaceId: string,
): Promise<SelfProfileResponse | null | { error: 'stale_role_migration_required' }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      role: true,
      createdAt: true,
      shiftAssignedAt: true,
      workspace: {
        select: {
          id: true,
          name: true,
          createdAt: true,
        },
      },
      team: {
        select: {
          id: true,
          name: true,
          managers: {
            orderBy: { createdAt: 'asc' },
            select: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  avatarUrl: true,
                },
              },
            },
          },
          _count: { select: { members: true } },
        },
      },
      shift: {
        select: {
          id: true,
          workspaceId: true,
          name: true,
          schedule: true,
          bufferMin: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { members: true } },
        },
      },
    },
  });

  if (!user || user.workspace.id !== workspaceId) return null;

  const parsedRole = RoleSchema.safeParse(user.role);
  if (!parsedRole.success) return { error: 'stale_role_migration_required' };

  const policy = await loadOrCreatePolicy(workspaceId);
  const manager = user.team?.managers.find((m) => m.user.id !== user.id)?.user ?? user.team?.managers[0]?.user ?? null;

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      role: parsedRole.data,
      displayRole: parsedRole.data,
      createdAt: user.createdAt.toISOString(),
    },
    workspace: {
      id: user.workspace.id,
      name: user.workspace.name,
      createdAt: user.workspace.createdAt.toISOString(),
    },
    team: user.team
      ? {
          id: user.team.id,
          name: user.team.name,
          memberCount: user.team._count.members,
        }
      : null,
    manager,
    shift: user.shift
      ? {
          id: user.shift.id,
          workspaceId: user.shift.workspaceId,
          name: user.shift.name,
          schedule: user.shift.schedule as NonNullable<SelfProfileResponse['shift']>['schedule'],
          bufferMin: user.shift.bufferMin,
          memberCount: user.shift._count.members,
          createdAt: user.shift.createdAt.toISOString(),
          updatedAt: user.shift.updatedAt.toISOString(),
          assignedAt: user.shiftAssignedAt ? user.shiftAssignedAt.toISOString() : null,
        }
      : null,
    policy: {
      captureApps: policy.captureApps,
      captureTitles: policy.captureTitles,
      captureUrls: policy.captureUrls,
      retentionDaysScreenshots: policy.retentionDaysScreenshots,
    },
  };
}
