import { Router } from 'express';
import { AgentAppIconsRequest, AgentConfigResponse, HeartbeatRequest, HeartbeatResponse } from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { prisma } from '@grind/db';
import { env } from '../env';

export const agentRouter = Router();

agentRouter.use(requireAccessToken);

/** First entry of the (possibly comma-separated) DASHBOARD_URL, trailing-slash trimmed. */
function dashboardOrigin(): string {
  return (env.DASHBOARD_URL ?? '').split(',')[0]?.trim().replace(/\/$/u, '') ?? '';
}

agentRouter.post('/heartbeat', validate(HeartbeatRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as HeartbeatRequest;
    const now = new Date();
    const updated = await prisma.user.updateMany({
      where: { id: req.user.sub, workspaceId: req.user.ws, deactivatedAt: null },
      data: {
        agentLastSeenAt: now,
        agentState: body.state,
        agentVersion: body.agentVersion,
        agentPlatform: body.platform,
        agentActiveEntryId: body.activeEntryId ?? null,
      },
    });
    if (updated.count === 0) return res.status(401).json({ error: 'unauthorized' });
    const response: HeartbeatResponse = { ok: true, serverTime: now.toISOString() };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

agentRouter.get('/config', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { workspaceId: true, screenshotIntervalMin: true, idleThresholdMin: true },
    });
    // Resolution: per-member override → workspace policy default → hardcoded fallback.
    const policy = user
      ? await prisma.workspacePolicy.findUnique({
          where: { workspaceId: user.workspaceId },
          select: { defaultScreenshotIntervalMin: true, defaultIdleThresholdMin: true },
        })
      : null;
    const response: AgentConfigResponse = {
      heartbeatIntervalSec: 60,
      screenshotIntervalMin: user?.screenshotIntervalMin ?? policy?.defaultScreenshotIntervalMin ?? 180,
      idleThresholdMin: user?.idleThresholdMin ?? policy?.defaultIdleThresholdMin ?? 5,
      dashboardUrl: dashboardOrigin(),
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * Agents upload real extracted app icons (PNG, base64), keyed by bundle id.
 * Idempotent upsert — icons are workspace-agnostic, so the latest upload for a
 * bundle wins. Oversized/empty payloads are skipped, not rejected, so one bad
 * icon never fails the batch.
 */
agentRouter.post('/app-icons', validate(AgentAppIconsRequest, 'body'), async (req, res, next) => {
  try {
    const { icons } = req.body as AgentAppIconsRequest;
    let stored = 0;
    for (const it of icons) {
      const png = Buffer.from(it.pngBase64, 'base64');
      if (png.length === 0 || png.length > 150_000) continue;
      await prisma.appIcon.upsert({
        where: { bundleId: it.bundleId },
        create: { bundleId: it.bundleId, app: it.app, png },
        update: { app: it.app, png },
      });
      stored += 1;
    }
    res.json({ ok: true as const, stored });
  } catch (err) {
    next(err);
  }
});
