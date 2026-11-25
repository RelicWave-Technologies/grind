import { Router, type Request } from 'express';
import { prisma } from '@grind/db';
import { clipInterval, isTracked } from '@grind/core';
import {
  CreateTimeRemovalRequest,
  TIME_REMOVAL_MIN_MS,
  hasPermission,
  type CreateTimeRemovalRequest as CreateBody,
} from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { attachScope } from '../middleware/scope';
import { resolveTimeEditTarget } from '../authz/timeEdit';
import { loadTimelineWindow } from '../time';
import { logger } from '../logger';

/**
 * Removing tracked time on Edit Time.
 *
 * A person can take part of their own tracked time away — a break the timer
 * ran through, a stretch that was not work — and has to say why. Nothing is
 * deleted: the removal is a `TimeInvalidation` with no flag, so the stretch is
 * still drawn, with the reason and who removed it, and every screen that reads
 * the shared timeline stops counting it.
 *
 * The rule this file keeps: **time only goes down here.** There is no call
 * that lengthens tracked time, and nobody can put their own removed time back
 * (an admin aside) — that is a manager's decision, like any other added time.
 */
export const timeRemovalsRouter = Router();
timeRemovalsRouter.use(requireAccessToken, attachScope);

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * POST /v1/time-removals
 * Body: { userId?, start, end, reason }
 *
 * Self, or someone the caller may edit (`time.team.edit`). The window must
 * be in the past and hold at least a minute of tracked time that still counts.
 */
timeRemovalsRouter.post('/', validate(CreateTimeRemovalRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as CreateBody;
    const authz = resolveTimeEditTarget(req, body.userId);
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });

    const now = new Date();
    const start = new Date(body.start);
    const end = new Date(body.end);
    if (!(end > start)) return res.status(400).json({ error: 'invalid_window' });
    if (end.getTime() > now.getTime()) return res.status(400).json({ error: 'window_in_future' });
    if (end.getTime() - start.getTime() < TIME_REMOVAL_MIN_MS) return res.status(400).json({ error: 'window_too_short' });
    if (end.getTime() - start.getTime() > MAX_WINDOW_MS) return res.status(400).json({ error: 'window_too_long' });

    // What the window would actually take away: tracked work and meetings that
    // still count. A window over a gap, idle, or time already removed has
    // nothing to remove — which also makes a double click harmless.
    const { pieces } = await loadTimelineWindow({
      userIds: [authz.targetUserId],
      start,
      end,
      now,
      lookbackMs: 0,
    });
    let removedMs = 0;
    for (const piece of pieces) {
      if (!isTracked(piece)) continue;
      const iv = clipInterval(piece, start.getTime(), end.getTime());
      if (iv) removedMs += iv.end - iv.start;
    }
    if (removedMs < TIME_REMOVAL_MIN_MS) return res.status(400).json({ error: 'no_tracked_time' });

    const row = await prisma.timeInvalidation.create({
      data: {
        workspaceId: req.scope.workspaceId,
        userId: authz.targetUserId,
        windowStart: start,
        windowEnd: end,
        invalidatedById: req.user.sub,
        reason: body.reason,
      },
      select: { id: true },
    });
    logger.info(
      { removalId: row.id, userId: authz.targetUserId, by: req.user.sub, start: body.start, end: body.end, removedMs },
      'tracked time removed on Edit Time',
    );
    res.status(201).json({ id: row.id, start: start.getTime(), end: end.getTime(), removedMs });
  } catch (err) {
    next(err);
  }
});

/**
 * May the caller put this person's removed time back? Someone who may edit
 * their time, and never their own unless they are an admin — the same shape
 * as an attendance correction.
 */
function canRestoreRemovedTimeOf(req: Request, userId: string): boolean {
  if (!req.scope || !req.user) return false;
  if (!hasPermission(req.scope.capabilities, 'time.team.edit')) return false;
  if (!req.scope.editUserIds.includes(userId)) return false;
  return req.scope.isAdmin || userId !== req.user.sub;
}

/**
 * DELETE /v1/time-removals/:id — put removed time back.
 *
 * Only for removals made on Edit Time. An invalidation that came from a flag
 * review is undone on the Flags page, where the verdict lives.
 */
timeRemovalsRouter.delete('/:id', async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const row = await prisma.timeInvalidation.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true, flagId: true, windowStart: true, windowEnd: true, reason: true },
    });
    // Out of scope reads as missing, so ids cannot be probed.
    if (!row || !req.scope.userIds.includes(row.userId)) return res.status(404).json({ error: 'not_found' });
    if (!canRestoreRemovedTimeOf(req, row.userId)) {
      return res.status(403).json({ error: row.userId === req.user.sub ? 'restore_needs_manager' : 'forbidden' });
    }
    if (row.flagId) return res.status(400).json({ error: 'flag_review_invalidation' });

    await prisma.timeInvalidation.delete({ where: { id: row.id } });
    logger.info(
      {
        removalId: row.id,
        userId: row.userId,
        by: req.user.sub,
        start: row.windowStart.toISOString(),
        end: row.windowEnd.toISOString(),
        reason: row.reason,
      },
      'removed time restored on Edit Time',
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
