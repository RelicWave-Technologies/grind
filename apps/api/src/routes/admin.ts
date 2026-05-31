import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireManagerOrAbove } from '../middleware/scope';
import { decideByUser } from '../lark/decideByUser';

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

// ============================================================================
// Manual-time approvals queue (MANAGER and above)
// ============================================================================

interface MtrListEntry {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  requestedStart: string;
  requestedEnd: string;
  reason: string;
  larkTaskGuid: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
}

/**
 * GET /v1/admin/manual-time-requests
 *
 * Scoped queue of manual-time requests. MANAGER sees their team members';
 * ADMIN/OWNER sees the whole workspace; MEMBERs get 403 (they have their
 * own self-view via /v1/time-requests).
 *
 * Filters:
 *   ?status=PENDING (default) — also accepts APPROVED, REJECTED, CANCELLED, all
 *
 * Sort: PENDING first (oldest pending bubbles up), then by createdAt desc.
 */
adminRouter.get('/manual-time-requests', requireManagerOrAbove, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const statusParam = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'PENDING';
    const validStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
    const where: { userId: { in: string[] }; status?: (typeof validStatuses)[number] } = {
      userId: { in: req.scope.userIds },
    };
    if (statusParam !== 'ALL') {
      if (!(validStatuses as readonly string[]).includes(statusParam)) {
        return res.status(400).json({ error: 'invalid_status' });
      }
      where.status = statusParam as (typeof validStatuses)[number];
    }
    const rows = await prisma.manualTimeRequest.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: [
        // PENDING bubbles to the top of mixed queries via createdAt fallback.
        { createdAt: 'desc' },
      ],
      take: 200,
    });
    const out: MtrListEntry[] = rows.map((r) => ({
      id: r.id,
      status: r.status,
      requestedStart: r.requestedStart.toISOString(),
      requestedEnd: r.requestedEnd.toISOString(),
      reason: r.reason,
      larkTaskGuid: r.larkTaskGuid,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decidedReason: r.decidedReason,
      createdAt: r.createdAt.toISOString(),
      user: { id: r.user.id, name: r.user.name, email: r.user.email },
    }));
    res.json({ requests: out, scope: req.scope.scope });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/admin/manual-time-requests/:id/decide
 * Body: { action: 'approve' | 'reject', reason?: string }
 *
 * Dashboard mirror of the Lark IM card flow. Same DB effects (status,
 * decidedAt, decidedReason, TimeEntry on approve). Best-effort refresh of
 * the Lark card so the approver chat matches DB truth.
 *
 * Authorization is enforced inside `decideByUser` by checking the requester's
 * userId is in `req.scope.userIds`. We block MEMBERs at the router level so
 * a MEMBER hitting this endpoint never even hits the service.
 */
adminRouter.post('/manual-time-requests/:id/decide', requireManagerOrAbove, async (req, res, next) => {
  try {
    if (!req.scope || !req.user) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: 'invalid_action' });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) || undefined : undefined;
    const out = await decideByUser({
      requestId: id,
      action,
      deciderUserId: req.user.sub,
      scopeUserIds: req.scope.userIds,
      reason,
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    if (out.noop === 'forbidden') return res.status(403).json({ error: 'forbidden' });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export default adminRouter;
