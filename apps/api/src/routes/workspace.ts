import { Router } from 'express';
import { prisma } from '@grind/db';
import { PatchWorkspaceSettingsRequest, type WorkspaceSettingsDto } from '@grind/types';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireAdmin } from '../middleware/scope';
import { updateWorkspaceTimezone } from '../workspace/timezone';

/**
 * Lightweight workspace-directory endpoints. Distinct from `/v1/admin/*`
 * which applies role-based scope: these return data that every
 * authenticated user is allowed to see for legit collaboration features
 * (attendee picker, mention search, etc.).
 *
 * Privacy note: workspace members already know each other by virtue of
 * being on the same Lark + same payroll. Sharing id + name + email is
 * a fair-trade for picker functionality. No phone numbers, no salaries,
 * no Lark open_ids leak through here.
 */
export const workspaceRouter = Router();
workspaceRouter.use(requireAccessToken);

function toSettingsDto(workspace: { id: string; name: string; timezone: string }): WorkspaceSettingsDto {
  return workspace;
}

workspaceRouter.get('/settings', attachScope, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const workspace = await prisma.workspace.findUnique({
      where: { id: req.scope.workspaceId },
      select: { id: true, name: true, timezone: true },
    });
    if (!workspace) return res.status(404).json({ error: 'workspace_not_found' });
    res.json(toSettingsDto(workspace));
  } catch (err) {
    next(err);
  }
});

workspaceRouter.patch('/settings', attachScope, requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const parsed = PatchWorkspaceSettingsRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_workspace_settings' });
    const workspace = await updateWorkspaceTimezone(req.scope.workspaceId, parsed.data.timezone);
    res.json(toSettingsDto(workspace));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/workspace/users — every user in the caller's workspace.
 *
 * Used by the attendee picker on the dashboard's /me-today composer
 * and the agent's "Request manual time" form. Limited fields by design.
 * Sorted by name for stable, scannable results.
 */
workspaceRouter.get('/users', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const users = await prisma.user.findMany({
      where: { workspaceId: req.user.ws },
      select: { id: true, name: true, email: true, avatarUrl: true, role: true },
      orderBy: [{ name: 'asc' }],
    });
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

export default workspaceRouter;
