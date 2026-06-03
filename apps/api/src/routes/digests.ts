import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireManagerOrAbove } from '../middleware/scope';
import {
  buildPendingDigests,
  formatDigestPlainText,
  type ApproverDigest,
} from '../digests/pendingDigest';
import { getLarkMessenger } from '../lark';
import { logger } from '../logger';

/**
 * Pending-approval digests (M15). Two endpoints:
 *
 *   GET  /v1/admin/digests/pending   — preview: returns per-approver
 *        digests the cron would send right now. MANAGER+ (no Lark needed).
 *   POST /v1/admin/digests/pending/send — actually fires the IMs. ADMIN
 *        only. Requires Lark to be configured + each approver to have a
 *        resolved LarkIdentity (openId). Returns counts so the admin
 *        can see what landed and what was skipped.
 *
 * Idempotency is intentionally NOT enforced here — calling /send twice
 * in a row sends twice. Cron will batch by date externally. This keeps
 * the surface small + debuggable.
 */
export const digestsRouter = Router();
digestsRouter.use(requireAccessToken, attachScope);

interface DigestPreviewItem {
  approverId: string;
  approverName: string | null;
  approverEmail: string | null;
  stuckCount: number;
  freshCount: number;
  totalCount: number;
  oldestAgeMs: number;
  items: ApproverDigest['stuck'];
}

/**
 * Collect all PENDING manual-time requests across the workspace, build
 * digests, and decorate each approver with their name/email + a single
 * combined item list (stuck first, then fresh).
 */
async function buildWorkspaceDigests(workspaceId: string, now: number): Promise<DigestPreviewItem[]> {
  const requests = await prisma.manualTimeRequest.findMany({
    where: { status: 'PENDING', user: { workspaceId } },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const digests = buildPendingDigests(
    requests.map((r) => ({
      id: r.id,
      approverId: r.approverId,
      requesterId: r.userId,
      requesterName: r.user.name,
      requestedStart: r.requestedStart.getTime(),
      requestedEnd: r.requestedEnd.getTime(),
      createdAtMs: r.createdAt.getTime(),
      reason: r.reason,
    })),
    { now },
  );

  // Resolve approver names + emails in one batch. '__unassigned__' is
  // never a real user; we leave name/email null so the dashboard can
  // route it to an "Unassigned" section.
  const realApproverIds = digests
    .map((d) => d.approverId)
    .filter((id) => id !== '__unassigned__');
  const approvers =
    realApproverIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: realApproverIds }, workspaceId },
          select: { id: true, name: true, email: true },
        })
      : [];
  const byId = new Map(approvers.map((u) => [u.id, u]));

  return digests.map((d) => {
    const user = byId.get(d.approverId);
    return {
      approverId: d.approverId,
      approverName: user?.name ?? null,
      approverEmail: user?.email ?? null,
      stuckCount: d.stuck.length,
      freshCount: d.fresh.length,
      totalCount: d.totalCount,
      oldestAgeMs: d.oldestAgeMs,
      items: [...d.stuck, ...d.fresh].slice(0, 20),
    };
  });
}

digestsRouter.get('/pending', requireManagerOrAbove, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const digests = await buildWorkspaceDigests(req.scope.workspaceId, Date.now());
    res.json({ digests });
  } catch (err) {
    next(err);
  }
});

digestsRouter.post('/pending/send', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    if (!req.scope.isAdmin) return res.status(403).json({ error: 'admin_only' });

    const messenger = getLarkMessenger();
    if (!messenger) {
      return res.status(503).json({ error: 'lark_not_configured' });
    }

    const now = Date.now();
    const previews = await buildWorkspaceDigests(req.scope.workspaceId, now);

    // Re-build full digests (with stuck/fresh split) so the body text is
    // shaped correctly. We can't reuse the trimmed `items` slice above
    // because formatDigestPlainText reads stuck/fresh separately.
    const requests = await prisma.manualTimeRequest.findMany({
      where: { status: 'PENDING', user: { workspaceId: req.scope.workspaceId } },
      include: { user: { select: { name: true } } },
    });
    const fullDigests = buildPendingDigests(
      requests.map((r) => ({
        id: r.id,
        approverId: r.approverId,
        requesterId: r.userId,
        requesterName: r.user.name,
        requestedStart: r.requestedStart.getTime(),
        requestedEnd: r.requestedEnd.getTime(),
        createdAtMs: r.createdAt.getTime(),
        reason: r.reason,
      })),
      { now },
    );

    // Look up open_ids for each real approver.
    const realApproverIds = fullDigests.map((d) => d.approverId).filter((id) => id !== '__unassigned__');
    const identities =
      realApproverIds.length > 0
        ? await prisma.larkIdentity.findMany({
            where: { userId: { in: realApproverIds } },
            select: { userId: true, openId: true },
          })
        : [];
    const openIdByUser = new Map(identities.map((i) => [i.userId, i.openId]));

    let sent = 0;
    let skippedNoLark = 0;
    let skippedUnassigned = 0;
    let failed = 0;
    const errors: Array<{ approverId: string; error: string }> = [];

    for (const digest of fullDigests) {
      if (digest.approverId === '__unassigned__') {
        skippedUnassigned += digest.totalCount;
        continue;
      }
      const openId = openIdByUser.get(digest.approverId);
      if (!openId) {
        skippedNoLark += 1;
        continue;
      }
      const text = formatDigestPlainText(digest);
      try {
        await messenger.sendText(openId, text);
        sent += 1;
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ approverId: digest.approverId, error: msg });
        logger.warn({ approverId: digest.approverId, err: msg }, 'digest send failed');
      }
    }

    res.json({
      sent,
      skippedNoLark,
      skippedUnassigned,
      failed,
      errors,
      previews,
    });
  } catch (err) {
    next(err);
  }
});

export default digestsRouter;
