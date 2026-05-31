import type { RequestHandler } from 'express';
import { prisma } from '@grind/db';

/**
 * Role-scoped query helpers for the M11+ admin dashboard.
 *
 * Three scope tiers:
 *   - self       MEMBER → can only see their own data
 *   - team       MANAGER → can see every user in any team they manage
 *   - workspace  ADMIN / OWNER → can see every user in their workspace
 *
 * The middleware attaches `req.scope` so route handlers don't have to repeat
 * the SQL filter. Always combine with `requireAccessToken` upstream so
 * `req.user` is set.
 */

export type Scope = 'self' | 'team' | 'workspace';

export interface ResolvedScope {
  scope: Scope;
  /** The full list of userIds the caller is allowed to see (incl. self). */
  userIds: string[];
  /** The caller's workspaceId. */
  workspaceId: string;
  /** True only for ADMIN / OWNER. Useful for "admin-only" routes within /v1/admin. */
  isAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      scope?: ResolvedScope;
    }
  }
}

/**
 * Resolves the caller's scope and pre-computes the visible user-id list.
 * Use as `app.use('/v1/admin', requireAccessToken, attachScope, ...)`.
 *
 * For MANAGERs we fetch the union of members across every team they manage
 * — usually 1 team, but we don't constrain that. We also include the
 * manager themselves so "My Day" works for managers.
 */
export const attachScope: RequestHandler = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  try {
    const role = req.user.role;
    const workspaceId = req.user.ws;
    const isAdmin = role === 'ADMIN' || role === 'OWNER';
    let scope: Scope;
    let userIds: string[];

    if (isAdmin) {
      scope = 'workspace';
      const users = await prisma.user.findMany({ where: { workspaceId }, select: { id: true } });
      userIds = users.map((u) => u.id);
    } else if (role === 'MANAGER') {
      scope = 'team';
      const teams = await prisma.team.findMany({
        where: { managerId: req.user.sub },
        include: { members: { select: { id: true } } },
      });
      const memberIds = new Set<string>([req.user.sub]);
      for (const t of teams) for (const m of t.members) memberIds.add(m.id);
      userIds = [...memberIds];
    } else {
      scope = 'self';
      userIds = [req.user.sub];
    }

    req.scope = { scope, userIds, workspaceId, isAdmin };
    next();
  } catch (err) {
    next(err);
  }
};

/** Gate a route to admin/owner only. Use after attachScope. */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.scope?.isAdmin) return res.status(403).json({ error: 'admin_only' });
  next();
};

/**
 * Gate a route to MANAGER, ADMIN, or OWNER. The approvals queue lives here:
 * MEMBERs have their own self-view via /v1/time-requests and don't need —
 * shouldn't see — anyone else's queue.
 */
export const requireManagerOrAbove: RequestHandler = (req, res, next) => {
  if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
  if (req.scope.scope === 'self') return res.status(403).json({ error: 'manager_or_above_only' });
  next();
};
