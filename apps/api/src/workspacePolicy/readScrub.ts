import { prisma } from '@grind/db';
import { WORKSPACE_POLICY_DEFAULTS, type PolicyFlags } from '@grind/types';

/** The capture flags in force for a workspace (defaults when it never set any). */
async function policyFlagsForWorkspace(workspaceId: string): Promise<PolicyFlags> {
  const row = await prisma.workspacePolicy.findUnique({
    where: { workspaceId },
    select: { captureApps: true, captureTitles: true, captureUrls: true },
  });
  return row ?? WORKSPACE_POLICY_DEFAULTS;
}

/** The capture flags in force for a user's workspace. */
export async function policyFlagsForUser(userId: string): Promise<PolicyFlags> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { workspaceId: true } });
  return user ? policyFlagsForWorkspace(user.workspaceId) : WORKSPACE_POLICY_DEFAULTS;
}

interface ActiveFieldsRow {
  activeApp?: string | null;
  activeAppBundle?: string | null;
  activeTitle?: string | null;
  activeUrl?: string | null;
}

/**
 * Hide, at read time, every active-window field the CURRENT policy does not
 * capture — whatever was stored under an earlier, wider policy. Only the
 * fields a row actually carries are touched.
 */
export function hideDisallowedActiveFields<T extends ActiveFieldsRow>(rows: T[], policy: PolicyFlags): T[] {
  if (policy.captureApps && policy.captureTitles && policy.captureUrls) return rows;
  return rows.map((row) => {
    const out: T = { ...row };
    if (!policy.captureApps) {
      if ('activeApp' in out) out.activeApp = null;
      if ('activeAppBundle' in out) out.activeAppBundle = null;
    }
    if ((!policy.captureApps || !policy.captureTitles) && 'activeTitle' in out) out.activeTitle = null;
    if ((!policy.captureApps || !policy.captureUrls) && 'activeUrl' in out) out.activeUrl = null;
    return out;
  });
}
