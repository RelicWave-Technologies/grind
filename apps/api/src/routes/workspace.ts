import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';

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
      select: { id: true, name: true, email: true, role: true },
      orderBy: [{ name: 'asc' }],
    });
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

export default workspaceRouter;
