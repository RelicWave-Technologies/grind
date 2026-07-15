import { Router } from 'express';
import {
  AgentAppIconsRequest,
  HeartbeatRequest,
  TodayLedgerQuery,
  WORKSPACE_POLICY_DEFAULTS,
  normalizeScreenshotIntervalMin,
  type AgentConfigResponse,
  type HeartbeatResponse,
  type TodayLedgerResponse,
} from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { prisma, type Prisma } from '@grind/db';
import { env } from '../env';
import { renewTimerLease, TIMER_PROTOCOL_VERSION, type TimerCheckpointResult } from '../timeLifecycle';
import { serializeTimeEntry } from '../timeEntries/wire';
import { loadEntryLiveEvidence } from '../insights/liveEntryEvidence';
import { resolveEffectiveEntrySegmentEnds } from '../insights/openSegmentEvidence';
import { resolveTodayLedgerMode } from '../agent/todayLedgerMode';

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
      workspace: { select: { timezone: true } },
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
  const ledgerMode = resolveTodayLedgerMode(
    env.TIMO_TODAY_LEDGER_MODE,
    env.TIMO_TODAY_LEDGER_CANARY_USER_IDS,
    userId,
  );
  const policyUpdatedAt = policy?.updatedAt.toISOString() ?? 'no-policy';
  const configVersion = [
    policyUpdatedAt,
    screenshotIntervalMin,
    idleThresholdMin,
    captureApps ? 'apps:on' : 'apps:off',
    captureTitles ? 'titles:on' : 'titles:off',
    captureUrls ? 'urls:on' : 'urls:off',
    dashboardUrl,
    user.workspace.timezone,
    `today-ledger:${ledgerMode}`,
  ].join('|');

  return {
    configVersion,
    heartbeatIntervalSec: 60,
    screenshotIntervalMin,
    idleThresholdMin,
    captureApps,
    captureTitles,
    captureUrls,
    todayLedgerMode: ledgerMode,
    dashboardUrl,
    workspaceTimezone: user.workspace.timezone,
  };
}

agentRouter.post('/heartbeat', validate(HeartbeatRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as HeartbeatRequest;
    const now = new Date();
    if (body.timerCheckpoint && body.trackingProtocolVersion !== TIMER_PROTOCOL_VERSION) {
      return res.status(400).json({ error: 'timer_protocol_mismatch' });
    }
    if (body.timerCheckpoint && body.state !== body.timerCheckpoint.state) {
      return res.status(400).json({ error: 'timer_state_mismatch' });
    }
    const data: Prisma.UserUpdateManyMutationInput = {
      agentLastSeenAt: now,
      agentVersion: body.agentVersion,
      agentPlatform: body.platform,
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
    if (body.startup) {
      data.agentLaunchAtLoginState = body.startup.state;
      data.agentLaunchOrigin = body.startup.origin;
      data.agentLaunchAtLoginUpdatedAt = now;
    }
    const heartbeatResult = await prisma.$transaction(async (tx): Promise<{
      authorized: boolean;
      timer: TimerCheckpointResult | null;
    }> => {
      const user = await tx.user.findFirst({
        where: { id: req.user!.sub, workspaceId: req.user!.ws, deactivatedAt: null },
        select: { id: true },
      });
      if (!user) return { authorized: false, timer: null };
      const timer = body.timerCheckpoint
        ? await renewTimerLease(tx, req.user!.sub, body.timerCheckpoint, now)
        : null;
      const legacyActiveEntry = !body.timerCheckpoint && body.activeEntryId
        ? await tx.timeEntry.findFirst({
            where: {
              id: body.activeEntryId,
              userId: req.user!.sub,
              endedAt: null,
            },
            select: { id: true },
          })
        : null;
      const timerStateAccepted = timer === null || timer.disposition === 'accepted' || timer.disposition === 'needs_sync';
      await tx.user.update({
        where: { id: user.id },
        data: {
          ...data,
          ...(timerStateAccepted
            ? {
                agentState: body.state,
                agentActiveEntryId: body.timerCheckpoint?.entryId ?? legacyActiveEntry?.id ?? null,
              }
            : {}),
        },
      });
      return { authorized: true, timer };
    });
    if (!heartbeatResult.authorized) return res.status(401).json({ error: 'unauthorized' });
    const config = await buildAgentConfig(req.user.sub, req.user.ws);
    if (!config) return res.status(401).json({ error: 'unauthorized' });
    const response: HeartbeatResponse = {
      ok: true,
      serverTime: now.toISOString(),
      configVersion: config.configVersion,
      timer: heartbeatResult.timer,
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
 * Complete, bounded server snapshot for the authenticated user's tracked day.
 * This is deliberately separate from the mutable local timer journal: clients
 * cache it as server evidence and reconcile by entry id/client UUID.
 */
agentRouter.get('/today-ledger', validate(TodayLedgerQuery, 'query'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const query = req.query as unknown as TodayLedgerQuery;
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to.getTime() - from.getTime() > 36 * 60 * 60_000) {
      return res.status(400).json({ error: 'today_ledger_range_too_large' });
    }

    const user = await prisma.user.findFirst({
      where: { id: req.user.sub, workspaceId: req.user.ws, deactivatedAt: null },
      select: { workspace: { select: { timezone: true } } },
    });
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const entries = await prisma.timeEntry.findMany({
      where: {
        userId: req.user.sub,
        source: 'AUTO',
        startedAt: { lt: to },
        OR: [{ endedAt: null }, { endedAt: { gt: from } }],
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      take: 2_001,
      include: { segments: true },
    });
    if (entries.length > 2_000) {
      return res.status(409).json({ error: 'today_ledger_snapshot_too_large' });
    }

    const now = new Date();
    const evidence = await loadEntryLiveEvidence(entries, now);
    const serialized = entries.map(serializeTimeEntry);
    const effectiveEntries = entries.map((entry) => {
      const effectiveEnds = resolveEffectiveEntrySegmentEnds({
        segments: entry.segments,
        entryEndedAt: entry.endedAt,
        now,
        evidence: evidence.get(entry.id),
        lifecycle: entry,
      });
      const segments = entry.segments.map((segment, index) => ({
        segmentId: segment.id,
        endedAt: effectiveEnds[index]?.toISOString() ?? null,
      }));
      const effectiveEntryEnd = entry.endedAt?.toISOString() ?? (
        segments.every((segment) => segment.endedAt !== null)
          ? segments.map((segment) => segment.endedAt!).sort().at(-1) ?? null
          : null
      );
      return { entryId: entry.id, endedAt: effectiveEntryEnd, segments };
    });
    const response: TodayLedgerResponse = {
      complete: true,
      serverTime: now.toISOString(),
      workspaceTimezone: user.workspace.timezone,
      entries: serialized,
      effectiveEntries,
    };
    return res.json(response);
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
