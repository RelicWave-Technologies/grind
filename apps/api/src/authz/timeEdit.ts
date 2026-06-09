import type { Request } from 'express';
import { hasPermission, type Permission } from '@grind/types';

export type TimeEditTarget =
  | { ok: true; targetUserId: string; isSelf: boolean }
  | { ok: false; status: 401 | 403; error: 'unauthorized' | 'forbidden' };

/**
 * Dashboard time edits are user-scoped, not route-scoped:
 * - members can edit only themselves (`time.self.edit`)
 * - managers/admins can edit users already exposed by attachScope
 *
 * Agent create/sync routes intentionally do not use this helper; the agent is
 * always self-owned and remains locked to req.user.sub.
 */
export function resolveTimeEditTarget(req: Request, requestedUserId?: string | null): TimeEditTarget {
  const trimmed = requestedUserId?.trim();
  return authorizeTimeEditForUser(req, trimmed && trimmed.length > 0 ? trimmed : undefined);
}

export function authorizeTimeEditForUser(req: Request, userId?: string | null): TimeEditTarget {
  if (!req.user || !req.scope) return { ok: false, status: 401, error: 'unauthorized' };
  const targetUserId = userId ?? req.user.sub;
  const isSelf = targetUserId === req.user.sub;
  const requiredPermission: Permission = isSelf ? 'time.self.edit' : 'time.team.edit';

  if (!hasPermission(req.scope.capabilities, requiredPermission)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  if (!req.scope.userIds.includes(targetUserId)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  return { ok: true, targetUserId, isSelf };
}
