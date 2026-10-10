import { Router } from 'express';
import {
  AgentAppIconsRequest,
  AgentCommandResultRequest,
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
import { dashboardOrigins, env } from '../env';
import { renewTimerLease, TIMER_PROTOCOL_VERSION, type TimerCheckpointResult } from '../timeLifecycle';
import { serializeTimeEntry } from '../timeEntries/wire';
import { effectiveEntrySegmentEnds } from '@grind/core';
import { loadEntryLiveEvidence } from '../insights/liveEntryEvidence';
import { loadInvalidations } from '../time';
import { resolveTodayLedgerMode } from '../agent/todayLedgerMode';
import { agentPermissionColumns } from '../agentPermissionColumns';
import { deliverAgentCommands, recordAgentCommandResult } from '../agent/commands';
import { nextSyncTrackingColumns, SYNC_TRACKING_SELECT } from '../agent/syncHealth';

export const agentRouter = Router();

agentRouter.use(requireAccessToken);

/** First entry of the (possibly comma-separated) DASHBOARD_URL, trailing-slash trimmed. */
function dashboardOrigin(): string {
  return dashboardOrigins()[0] ?? '';
}

async function buildAgentConfig(userId: string, workspaceId: string): Promise<AgentConfigResponse | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, workspaceId, deactivatedAt: null },
    select: {
      workspaceId: true,
      workspace: { select: { timezone: true } },
      screenshotIntervalMin: true,
      idleThresholdMin: true,
      idleWarningSeconds: true,
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
  const idleWarningSeconds =
    user.idleWarningSeconds != null && user.idleWarningSeconds < idleThresholdMin * 60
      ? user.idleWarningSeconds
      : null;
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
    idleWarningSeconds ?? 'idle-warning:off',
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
    idleWarningSeconds,
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
      Object.assign(data, agentPermissionColumns(body.permissions));
      data.agentPermissionsUpdatedAt = now;
    }
    if (body.startup) {
      data.agentLaunchAtLoginState = body.startup.state;
      data.agentLaunchOrigin = body.startup.origin;
      data.agentLaunchAtLoginUpdatedAt = now;
    }
    if (body.diagnostics) {
      data.agentOsVersion = body.diagnostics.osVersion;
      data.agentArch = body.diagnostics.arch;
      data.agentSyncPending = body.diagnostics.syncPending;
      data.agentSyncOldestPendingAt = body.diagnostics.syncOldestPendingAt
        ? new Date(body.diagnostics.syncOldestPendingAt)
        : null;
      data.agentSyncLastError = body.diagnostics.syncLastError;
      // Update health arrived with beta.38: an older agent's diagnostics leave
      // these columns as they were rather than wiping them.
      if (body.diagnostics.installScope !== undefined) data.agentInstallScope = body.diagnostics.installScope;
      if (body.diagnostics.updateError !== undefined) data.agentUpdateError = body.diagnostics.updateError;
      data.agentDiagnosticsUpdatedAt = now;
    }
    const heartbeatResult = await prisma.$transaction(async (tx): Promise<{
      authorized: boolean;
      timer: TimerCheckpointResult | null;
    }> => {
      const user = await tx.user.findFirst({
        where: { id: req.user!.sub, workspaceId: req.user!.ws, deactivatedAt: null },
        select: { id: true, ...SYNC_TRACKING_SELECT },
      });
      if (!user) return { authorized: false, timer: null };
      // Server-clock sync bookkeeping; also caps a pending count the column can't hold.
      const syncTracking = body.diagnostics ? nextSyncTrackingColumns(user, body.diagnostics, now) : {};
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
      // Two devices on one account: the one not tracking still heartbeats,
      // with no checkpoint. Taking its word cleared the other device's running
      // timer from presence every minute. While a v2 timer this heartbeat did
      // not mention still holds a live lease, presence stays with that timer.
      const otherDeviceTimer = !body.timerCheckpoint && !legacyActiveEntry
        ? await tx.timeEntry.findFirst({
            where: {
              userId: req.user!.sub,
              source: 'AUTO',
              endedAt: null,
              trackingProtocolVersion: TIMER_PROTOCOL_VERSION,
              leaseExpiresAt: { gt: now },
            },
            select: { id: true },
          })
        : null;
      const timerStateAccepted = timer === null
        ? otherDeviceTimer === null
        : timer.disposition === 'accepted' || timer.disposition === 'needs_sync';
      await tx.user.update({
        where: { id: user.id },
        data: {
          ...data,
          ...syncTracking,
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
    const commands = await deliverAgentCommands(req.user.sub, now);
    const response: HeartbeatResponse = {
      ok: true,
      serverTime: now.toISOString(),
      configVersion: config.configVersion,
      timer: heartbeatResult.timer,
      ...(commands.length > 0 ? { commands } : {}),
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * The agent's outcome for a developer command it was handed on a heartbeat.
 * Only the command's target can report it; repeats are answered as success.
 */
agentRouter.post('/commands/:id/result', validate(AgentCommandResultRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as AgentCommandResultRequest;
    const outcome = await recordAgentCommandResult({
      id: req.params.id!,
      userId: req.user.sub,
      workspaceId: req.user.ws,
      body,
      now: new Date(),
    });
    if (outcome.kind === 'not_found') return res.status(404).json({ error: 'not_found' });
    if (outcome.kind === 'recorded') {
      req.log?.info({ commandId: req.params.id, status: body.status }, 'agent command completed');
    }
    res.json({ ok: true as const, status: outcome.status, alreadyCompleted: outcome.kind === 'already_completed' });
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
 * cache it as server evidence and reconcile by entry id/client UUID. Approved
 * manual time is returned separately so older agents keep their AUTO-only
 * response contract while newer agents can include it in today's total.
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

    const allEntries = await prisma.timeEntry.findMany({
      where: {
        userId: req.user.sub,
        source: { in: ['AUTO', 'MANUAL'] },
        startedAt: { lt: to },
        OR: [{ endedAt: null }, { endedAt: { gt: from } }],
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      take: 2_001,
      include: { segments: true },
    });
    if (allEntries.length > 2_000) {
      return res.status(409).json({ error: 'today_ledger_snapshot_too_large' });
    }

    const now = new Date();
    const invalidations = await loadInvalidations([req.user.sub], from, to);
    const autoEntries = allEntries.filter((entry) => entry.source === 'AUTO');
    const approvedManualEntries = allEntries.filter((entry) => entry.source === 'MANUAL');
    const evidence = await loadEntryLiveEvidence(autoEntries, now);
    const serialized = autoEntries.map(serializeTimeEntry);
    const effectiveEntries = autoEntries.map((entry) => {
      const effectiveEnds = effectiveEntrySegmentEnds({
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
      approvedManualEntries: approvedManualEntries.map(serializeTimeEntry),
      effectiveEntries,
      invalidations: invalidations.map((iv) => ({
        startedAt: new Date(iv.start).toISOString(),
        endedAt: new Date(iv.end).toISOString(),
      })),
    };
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * Agents upload real extracted app icons (PNG, base64), keyed by bundle id.
 * Insert-only — icons are workspace-agnostic, so the first upload for a bundle
 * is kept and later uploads are ignored. Oversized/empty payloads are skipped,
 * not rejected, so one bad icon never fails the batch. The body stays under the
 * global 64kb JSON cap; a bigger batch is answered 413 for the agent to split.
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
    // Icons are shared by every workspace, keyed only by bundle id. Insert-only:
    // the first upload of a bundle wins and nobody's agent — in this workspace
    // or another — can overwrite the icon everyone else is shown.
    const rows = icons
      .map((it) => ({ bundleId: it.bundleId, app: it.app, png: Buffer.from(it.pngBase64, 'base64') }))
      .filter((row) => row.png.length > 0 && row.png.length <= 150_000);
    const { count: stored } = rows.length
      ? await prisma.appIcon.createMany({ data: rows, skipDuplicates: true })
      : { count: 0 };
    res.json({ ok: true as const, stored });
  } catch (err) {
    next(err);
  }
});
