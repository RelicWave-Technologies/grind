import { Router } from 'express';
import {
  AgentAppIconsRequest,
  HeartbeatRequest,
  WORKSPACE_POLICY_DEFAULTS,
  normalizeScreenshotIntervalMin,
  type AgentConfigResponse,
  type HeartbeatResponse,
} from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { prisma, type Prisma } from '@grind/db';
import { env } from '../env';

export const agentRouter = Router();

agentRouter.use(requireAccessToken);

/** First entry of the (possibly comma-separated) DASHBOARD_URL, trailing-slash trimmed. */
function dashboardOrigin(): string {
  return (env.DASHBOARD_URL ?? '').split(',')[0]?.trim().replace(/\/$/u, '') ?? '';
}

async function buildAgentConfig(userId: string, workspaceId: string): Promise<AgentConfigResponse | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, workspaceId, deactivatedAt: null },
    select: {
      workspaceId: true,
      screenshotIntervalMin: true,
      idleThresholdMin: true,
    },
  });
  if (!user) return null;

  const policy = await prisma.workspacePolicy.findUnique({
    where: { workspaceId: user.workspaceId },
    select: {
      captureApps: true,
      captureTitles: true,
      captureUrls: true,
      defaultScreenshotIntervalMin: true,
      defaultIdleThresholdMin: true,
      updatedAt: true,
    },
  });

  const policyScreenshotIntervalMin = normalizeScreenshotIntervalMin(
    policy?.defaultScreenshotIntervalMin,
    WORKSPACE_POLICY_DEFAULTS.defaultScreenshotIntervalMin,
  );
  const screenshotIntervalMin = normalizeScreenshotIntervalMin(
    user.screenshotIntervalMin,
    policyScreenshotIntervalMin,
  );
  const idleThresholdMin =
    user.idleThresholdMin ??
    policy?.defaultIdleThresholdMin ??
    WORKSPACE_POLICY_DEFAULTS.defaultIdleThresholdMin;
  const captureApps = policy?.captureApps ?? WORKSPACE_POLICY_DEFAULTS.captureApps;
  const captureTitles = policy?.captureTitles ?? WORKSPACE_POLICY_DEFAULTS.captureTitles;
  const captureUrls = policy?.captureUrls ?? WORKSPACE_POLICY_DEFAULTS.captureUrls;
  const dashboardUrl = dashboardOrigin();
  const policyUpdatedAt = policy?.updatedAt.toISOString() ?? 'no-policy';
  const configVersion = [
    policyUpdatedAt,
    screenshotIntervalMin,
    idleThresholdMin,
    captureApps ? 'apps:on' : 'apps:off',
    captureTitles ? 'titles:on' : 'titles:off',
    captureUrls ? 'urls:on' : 'urls:off',
    dashboardUrl,
  ].join('|');

  return {
    configVersion,
    heartbeatIntervalSec: 60,
    screenshotIntervalMin,
    idleThresholdMin,
    captureApps,
    captureTitles,
    captureUrls,
    dashboardUrl,
  };
}

agentRouter.post('/heartbeat', validate(HeartbeatRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as HeartbeatRequest;
    const now = new Date();
    const data: Prisma.UserUpdateManyMutationInput = {
      agentLastSeenAt: now,
      agentState: body.state,
      agentVersion: body.agentVersion,
      agentPlatform: body.platform,
      agentActiveEntryId: body.activeEntryId ?? null,
    };
    if (body.permissions) {
      data.agentScreenPermissionStatus = body.permissions.screen.status;
      data.agentScreenCaptureHealth = body.permissions.screen.health;
      data.agentScreenPermissionState = body.permissions.screen.state;
      data.agentAccessibilityTrusted = body.permissions.accessibility.trusted;
      data.agentAccessibilityReady = body.permissions.accessibility.ready;
      data.agentAccessibilityRecording = body.permissions.accessibility.recording;
      data.agentAccessibilityCapturing = body.permissions.accessibility.capturing;
      data.agentAccessibilityHookRunning = body.permissions.accessibility.hookRunning;
      data.agentPermissionsUpdatedAt = now;
    }
    const updated = await prisma.user.updateMany({
      where: { id: req.user.sub, workspaceId: req.user.ws, deactivatedAt: null },
      data,
    });
    if (updated.count === 0) return res.status(401).json({ error: 'unauthorized' });
    const config = await buildAgentConfig(req.user.sub, req.user.ws);
    if (!config) return res.status(401).json({ error: 'unauthorized' });
    const response: HeartbeatResponse = {
      ok: true,
      serverTime: now.toISOString(),
      configVersion: config.configVersion,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

agentRouter.get('/config', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const response = await buildAgentConfig(req.user.sub, req.user.ws);
    if (!response) return res.status(401).json({ error: 'unauthorized' });
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
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const policy = await prisma.workspacePolicy.findUnique({
      where: { workspaceId: req.user.ws },
      select: { captureApps: true },
    });
    if (!(policy?.captureApps ?? WORKSPACE_POLICY_DEFAULTS.captureApps)) {
      return res.json({ ok: true as const, stored: 0 });
    }
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
