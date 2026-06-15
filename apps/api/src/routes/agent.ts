import { Router } from 'express';
import { AgentConfigResponse, HeartbeatRequest, HeartbeatResponse } from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { prisma } from '@grind/db';

export const agentRouter = Router();

agentRouter.use(requireAccessToken);

agentRouter.post('/heartbeat', validate(HeartbeatRequest, 'body'), (_req, res) => {
  const response: HeartbeatResponse = { ok: true, serverTime: new Date().toISOString() };
  res.json(response);
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
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});
