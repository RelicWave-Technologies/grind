import type { Request, RequestHandler } from 'express';
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
 *   - team       MANAGER, or HR who manages a team → every user in that team
 *   - workspace  ADMIN → every user in their workspace
 *
 * HR's People tab reaches the whole workspace through `people.manage` on its
 * own routes, never through this scope: her reports are her position's.
 *
 * The middleware attaches `req.scope` so route handlers don't have to repeat
 * the SQL filter. Always combine with `requireAccessToken` upstream so
 * `req.user` is set.
 */

type Scope = 'self' | 'team' | 'workspace';

export interface ResolvedScope {
  scope: Scope;
  /** The full list of userIds the caller is allowed to see (incl. self). */
  userIds: string[];
  /**
   * Whose time, attendance, approvals and flags the caller may CHANGE. Today
   * the same list as `userIds` for every role; kept apart so that a role which
   * reads more than it may change can never widen its edits by accident.
   * Every edit route checks this, never `userIds`.
   */
  editUserIds: string[];
  /** The caller's workspaceId. */
  workspaceId: string;
  /** Canonical workspace-owned business timezone. */
  workspaceTimezone: string;
  /** True only for ADMIN — never HR, whose People powers come from `people.manage`. */
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
  // Already resolved for this request (a router nested under another that
  // attached it): the answer cannot have changed, so don't query it again.
  if (req.scope) return next();
  try {
    const workspaceId = req.user.ws;
    const currentUser = await prisma.user.findFirst({
      where: { id: req.user.sub, workspaceId, deactivatedAt: null },
      select: { role: true, workspace: { select: { timezone: true } } },
    });
    if (!currentUser) return res.status(401).json({ error: 'unauthorized' });
    const role = currentUser.role;
    req.user.role = role;
    const managedTeam = role === 'HR' || role === 'MANAGER'
      ? await prisma.teamManager.findUnique({
          where: { userId: req.user.sub },
          include: { team: { include: { members: { where: { deactivatedAt: null }, select: { id: true } } } } },
        })
      : null;
    const capabilities = roleCapabilities(role, { managesTeam: managedTeam !== null });
    const isAdmin = role === 'ADMIN';
    const teamIds = new Set<string>([req.user.sub]);
    if (managedTeam) for (const m of managedTeam.team.members) teamIds.add(m.id);
    let scope: Scope;
    let userIds: string[];

    if (hasPermission(capabilities, 'reports.workspace.read')) {
      scope = 'workspace';
      // Skip deactivated users so the admin queue, /overview, reports, etc.
      // don't surface offboarded teammates. Their history stays
      // queryable through direct user-id lookups.
      const users = await prisma.user.findMany({
        where: { workspaceId, deactivatedAt: null },
        select: { id: true },
      });
      userIds = users.map((u) => u.id);
    } else if (role === 'MANAGER' || (role === 'HR' && managedTeam)) {
      scope = 'team';
      userIds = [...teamIds];
    } else {
      scope = 'self';
      userIds = [req.user.sub];
    }

    const editUserIds = userIds;
    req.scope = { scope, userIds, editUserIds, workspaceId, workspaceTimezone: currentUser.workspace.timezone, isAdmin, capabilities };
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * May the caller read this person's evidence (screenshots)? Everyone in scope,
 * plus — for an admin — a suspended person of the same workspace. Scope leaves
 * suspended people out so lists stay current, but the month report keeps them
 * on the months they worked, and an admin reviewing those months must be able
 * to open what they captured. Managers never see past their live team.
 */
export async function canReadEvidenceOf(req: Request, userId: string): Promise<boolean> {
  if (!req.scope) return false;
  if (req.scope.userIds.includes(userId)) return true;
  if (!req.scope.isAdmin) return false;
  const suspended = await prisma.user.findFirst({
    where: { id: userId, workspaceId: req.scope.workspaceId, deactivatedAt: { not: null } },
    select: { id: true },
  });
  return suspended !== null;
}

/**
 * May the caller correct this person's attendance? Their own team's (an
 * admin's: anyone's), never their own unless they are an admin. HR corrects
 * only the team she manages, like any manager.
 */
export function canCorrectAttendanceOf(req: Request, userId: string): boolean {
  if (!req.scope || !req.user) return false;
  if (!hasPermission(req.scope.capabilities, 'attendance.correct')) return false;
  if (!req.scope.editUserIds.includes(userId)) return false;
  return req.scope.isAdmin || userId !== req.user.sub;
}

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
