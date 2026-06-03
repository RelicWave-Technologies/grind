import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { attachScope } from '../middleware/scope';

/**
 * Mounted under `/v1/admin`. Every route requires a valid access token and
 * the resolved scope (self / team / workspace). Routes are intentionally
 * scope-aware: a MEMBER hitting `/v1/admin/users` gets their own row;
 * a MANAGER gets their team; ADMIN/OWNER gets the whole workspace.
 */
export const adminRouter = Router();
adminRouter.use(requireAccessToken, attachScope);

interface UserListEntry {
  id: string;
  email: string;
  name: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
  teamId: string | null;
  managerId: string | null;
  createdAt: string;
}

/**
 * GET /v1/admin/users — every user the caller is allowed to see, including
 * the caller themselves. Order: managers + admins first (for the dashboard
 * "People" table), then by name.
 */
adminRouter.get('/users', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const users = await prisma.user.findMany({
      where: { id: { in: req.scope.userIds } },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        teamId: true,
        managerId: true,
        createdAt: true,
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
    const out: UserListEntry[] = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      teamId: u.teamId,
      managerId: u.managerId,
      createdAt: u.createdAt.toISOString(),
    }));
    res.json({ users: out, scope: req.scope.scope });
  } catch (err) {
    next(err);
  }
});

export default adminRouter;
