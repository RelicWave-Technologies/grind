import type { RequestHandler } from 'express';
import { prisma } from '@grind/db';
import {
  hasPermission,
  roleCapabilities,
  type Permission,
} from '@grind/types';

/**
 * Role-scoped query helpers for the M11+ admin dashboard.
 *
 * Three scope tiers:
 *   - self       MEMBER → can only see their own data
 *   - team       MANAGER → can see every user in the one team they manage
 *   - workspace  ADMIN → can see every user in their workspace
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
  /** True only for ADMIN. Useful for admin-only routes within /v1/admin. */
  isAdmin: boolean;
  capabilities: Permission[];
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
 * For MANAGERs we fetch members of the single team they manage. We also
 * include the manager themselves so "My Day" works for managers.
 */
export const attachScope: RequestHandler = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  try {
    const workspaceId = req.user.ws;
    const currentUser = await prisma.user.findFirst({
      where: { id: req.user.sub, workspaceId, deactivatedAt: null },
      select: { role: true },
    });
    if (!currentUser) return res.status(401).json({ error: 'unauthorized' });
    const role = currentUser.role;
    req.user.role = role;
    const capabilities = roleCapabilities(role);
    const isAdmin = hasPermission(capabilities, 'people.manage');
    let scope: Scope;
    let userIds: string[];

    if (isAdmin) {
      scope = 'workspace';
      // Skip deactivated users so the admin queue, /overview, payroll, etc.
      // don't surface offboarded teammates. Their history stays
      // queryable through direct user-id lookups.
      const users = await prisma.user.findMany({
        where: { workspaceId, deactivatedAt: null },
        select: { id: true },
      });
      userIds = users.map((u) => u.id);
    } else if (role === 'MANAGER') {
      scope = 'team';
      const managed = await prisma.teamManager.findUnique({
        where: { userId: req.user.sub },
        include: {
          team: {
            include: { members: { where: { deactivatedAt: null }, select: { id: true } } },
          },
        },
      });
      const memberIds = new Set<string>([req.user.sub]);
      if (managed) for (const m of managed.team.members) memberIds.add(m.id);
      userIds = [...memberIds];
    } else {
      scope = 'self';
      userIds = [req.user.sub];
    }

    req.scope = { scope, userIds, workspaceId, isAdmin, capabilities };
    next();
  } catch (err) {
    next(err);
  }
};

/** Gate a route to ADMIN only. Use after attachScope. */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.scope?.isAdmin) return res.status(403).json({ error: 'admin_only' });
  next();
};

export function requireCapability(permission: Permission): RequestHandler {
  return (req, res, next) => {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    if (!hasPermission(req.scope.capabilities, permission)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

export function requireAnyCapability(permissions: readonly Permission[]): RequestHandler {
  return (req, res, next) => {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const { capabilities } = req.scope;
    if (!permissions.some((permission) => hasPermission(capabilities, permission))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

/**
 * Gate a route to MANAGER or ADMIN. The approvals queue lives here:
 * MEMBERs have their own self-view via /v1/time-requests and don't need —
 * shouldn't see — anyone else's queue.
 */
export const requireManagerOrAbove: RequestHandler = (req, res, next) => {
  if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
  if (req.scope.scope === 'self') return res.status(403).json({ error: 'manager_or_above_only' });
  next();
};
