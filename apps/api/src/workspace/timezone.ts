import { prisma, type Prisma } from '@grind/db';

/**
 * The Workspace owns the business calendar. PayrollPolicy and TesterOpsConfig
 * retain their timezone columns only for backward-compatible reads; whenever
 * the canonical value changes, both mirrors move in the same transaction.
 */
export async function getWorkspaceTimezone(workspaceId: string): Promise<string> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { timezone: true },
  });
  if (!workspace) throw new Error('workspace_not_found');
  return workspace.timezone;
}

export async function setWorkspaceTimezone(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  timezone: string,
): Promise<{ id: string; name: string; timezone: string }> {
  const workspace = await tx.workspace.update({
    where: { id: workspaceId },
    data: { timezone },
    select: { id: true, name: true, timezone: true },
  });

  await Promise.all([
    tx.payrollPolicy.updateMany({
      where: { workspaceId },
      data: { timezone: workspace.timezone },
    }),
    tx.testerOpsConfig.updateMany({
      where: { workspaceId },
      data: { timezone: workspace.timezone },
    }),
  ]);

  return workspace;
}

export async function updateWorkspaceTimezone(
  workspaceId: string,
  timezone: string,
): Promise<{ id: string; name: string; timezone: string }> {
  return prisma.$transaction((tx) => setWorkspaceTimezone(tx, workspaceId, timezone));
}
