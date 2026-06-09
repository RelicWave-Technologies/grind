import { Router } from 'express';
import { prisma } from '@grind/db';
import {
  PatchWorkspacePolicyRequest,
  WORKSPACE_POLICY_DEFAULTS,
  type WorkspacePolicyDto,
} from '@grind/types';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireAdmin } from '../middleware/scope';

/**
 * Workspace-wide capture policy (M14). One row per workspace; created on
 * demand from defaults on first read. The privacy contract is that we
 * default OFF — apps/titles/URLs are only captured when an ADMIN
 * explicitly flips the flags.
 *
 * Mounted under /v1/admin/workspace-policy:
 *   GET    → returns the current row (creates defaults if missing)
 *   PATCH  → ADMIN-only; merges into the row
 *
 * Every user in the workspace can READ the policy (so the agent can ask
 * "am I allowed to capture titles?"). Only ADMIN can WRITE.
 */
export const workspacePolicyRouter = Router();
workspacePolicyRouter.use(requireAccessToken, attachScope);

/** Returns the policy row, creating it from defaults if it doesn't exist yet. */
async function loadOrCreatePolicy(workspaceId: string) {
  const existing = await prisma.workspacePolicy.findUnique({ where: { workspaceId } });
  if (existing) return existing;
  return prisma.workspacePolicy.create({
    data: { workspaceId, ...WORKSPACE_POLICY_DEFAULTS },
  });
}

function toDto(row: {
  workspaceId: string;
  captureApps: boolean;
  captureTitles: boolean;
  captureUrls: boolean;
  retentionDaysScreenshots: number;
  defaultScreenshotIntervalMin: number;
  defaultIdleThresholdMin: number;
  createdAt: Date;
  updatedAt: Date;
}): WorkspacePolicyDto {
  return {
    workspaceId: row.workspaceId,
    captureApps: row.captureApps,
    captureTitles: row.captureTitles,
    captureUrls: row.captureUrls,
    retentionDaysScreenshots: row.retentionDaysScreenshots,
    defaultScreenshotIntervalMin: row.defaultScreenshotIntervalMin,
    defaultIdleThresholdMin: row.defaultIdleThresholdMin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

workspacePolicyRouter.get('/', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const row = await loadOrCreatePolicy(req.scope.workspaceId);
    res.json(toDto(row));
  } catch (err) {
    next(err);
  }
});

workspacePolicyRouter.patch('/', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const parsed = PatchWorkspacePolicyRequest.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', issues: parsed.error.flatten() });
    }
    // Upsert so a workspace whose policy row was never materialised
    // doesn't 404 on the first admin flip.
    const row = await prisma.workspacePolicy.upsert({
      where: { workspaceId: req.scope.workspaceId },
      create: {
        workspaceId: req.scope.workspaceId,
        ...WORKSPACE_POLICY_DEFAULTS,
        ...parsed.data,
      },
      update: parsed.data,
    });
    res.json(toDto(row));
  } catch (err) {
    next(err);
  }
});

export default workspacePolicyRouter;
