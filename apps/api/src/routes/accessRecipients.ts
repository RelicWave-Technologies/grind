import { Router } from 'express';
import { prisma } from '@grind/db';
import { PutAccessRequestRecipientsRequest, type AccessRequestRecipientsResponse } from '@grind/types';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireAdmin } from '../middleware/scope';

/**
 * Who gets the Lark card when a new person asks for access, at
 * /v1/admin/access-requests. Only admins can approve, so only
 * admins can be picked; picking none means every admin.
 */
export const accessRecipientsRouter = Router();
accessRecipientsRouter.use(requireAccessToken, attachScope);

async function load(workspaceId: string): Promise<AccessRequestRecipientsResponse> {
  const [policy, admins] = await Promise.all([
    prisma.workspacePolicy.findUnique({ where: { workspaceId }, select: { accessRequestRecipientIds: true } }),
    prisma.user.findMany({
      where: { workspaceId, role: 'ADMIN', provisioningStatus: 'ACTIVE', deactivatedAt: null },
      select: { id: true, name: true, email: true, larkIdentity: { select: { id: true } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  const chosen = new Set(policy?.accessRequestRecipientIds ?? []);
  const rows = admins.map((a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    hasLark: Boolean(a.larkIdentity),
    chosen: chosen.has(a.id),
  }));
  return { allAdmins: !rows.some((r) => r.chosen), admins: rows };
}

accessRecipientsRouter.get('/recipients', requireAdmin, async (req, res, next) => {
  try {
    res.json(await load(req.scope!.workspaceId));
  } catch (err) {
    next(err);
  }
});

accessRecipientsRouter.put('/recipients', requireAdmin, async (req, res, next) => {
  try {
    const parsed = PutAccessRequestRecipientsRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
    const workspaceId = req.scope!.workspaceId;
    const ids = [...new Set(parsed.data.userIds)];
    const valid = await prisma.user.count({
      where: { id: { in: ids }, workspaceId, role: 'ADMIN', provisioningStatus: 'ACTIVE', deactivatedAt: null },
    });
    if (valid !== ids.length) return res.status(400).json({ error: 'not_an_admin' });
    await prisma.workspacePolicy.upsert({
      where: { workspaceId },
      create: { workspaceId, accessRequestRecipientIds: ids },
      update: { accessRequestRecipientIds: ids },
    });
    res.json(await load(workspaceId));
  } catch (err) {
    next(err);
  }
});
