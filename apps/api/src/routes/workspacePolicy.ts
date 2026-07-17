import { Router } from 'express';
import { prisma } from '@grind/db';
import {
  PatchWorkspacePolicyRequest,
  WORKSPACE_POLICY_DEFAULTS,
  normalizeScreenshotIntervalMin,
  type WorkspacePolicyDto,
} from '@grind/types';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireAdmin } from '../middleware/scope';
import {
  monitoringRiskLevel,
  monitoringTimingChanged,
  normalizeAuditReason,
} from '../monitoringSettingsAudit';

/**
 * Workspace-wide capture policy (M14). One row per workspace; created on
 * demand from defaults on first read. The privacy contract is that we
 * default OFF — apps/titles/URLs are only captured when an ADMIN
 * explicitly flips the flags.
 *
 * Mounted under /v1/admin/workspace-policy:
 *   GET    → returns the current row (creates defaults if missing)
 *   PATCH  → ADMIN-only; merges into the row
 *
 * Every user in the workspace can READ the policy (so the agent can ask
 * "am I allowed to capture titles?"). Only ADMIN can WRITE.
 */
export const workspacePolicyRouter = Router();
workspacePolicyRouter.use(requireAccessToken, attachScope);

/** Returns the policy row, creating it from defaults if it doesn't exist yet. */
async function loadOrCreatePolicy(workspaceId: string) {
  const existing = await prisma.workspacePolicy.findUnique({ where: { workspaceId } });
  if (existing) return existing;
  return prisma.workspacePolicy.create({
    data: { workspaceId, ...WORKSPACE_POLICY_DEFAULTS },
  });
}

function toDto(row: {
  workspaceId: string;
  captureApps: boolean;
  captureTitles: boolean;
  captureUrls: boolean;
  retentionDaysScreenshots: number;
  defaultScreenshotIntervalMin: number;
  defaultIdleThresholdMin: number;
  createdAt: Date;
  updatedAt: Date;
}): WorkspacePolicyDto {
  return {
    workspaceId: row.workspaceId,
    captureApps: row.captureApps,
    captureTitles: row.captureTitles,
    captureUrls: row.captureUrls,
    retentionDaysScreenshots: row.retentionDaysScreenshots,
    defaultScreenshotIntervalMin: normalizeScreenshotIntervalMin(
      row.defaultScreenshotIntervalMin,
      WORKSPACE_POLICY_DEFAULTS.defaultScreenshotIntervalMin,
    ),
    defaultIdleThresholdMin: row.defaultIdleThresholdMin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

workspacePolicyRouter.get('/', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const row = await loadOrCreatePolicy(req.scope.workspaceId);
    res.json(toDto(row));
  } catch (err) {
    next(err);
  }
});

workspacePolicyRouter.patch('/', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope || !req.user) return res.status(500).json({ error: 'scope_unresolved' });
    const parsed = PatchWorkspacePolicyRequest.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', issues: parsed.error.flatten() });
    }
    const { auditReason: rawAuditReason, ...updateData } = parsed.data;
    const current = await loadOrCreatePolicy(req.scope.workspaceId);
    const merged = {
      captureApps: updateData.captureApps ?? current.captureApps,
      captureTitles: updateData.captureTitles ?? current.captureTitles,
      captureUrls: updateData.captureUrls ?? current.captureUrls,
    };
    if (!merged.captureApps && (merged.captureTitles || merged.captureUrls)) {
      return res.status(400).json({ error: 'invalid_capture_policy', message: 'capture_titles_or_urls_require_apps' });
    }

    const previousTiming = {
      screenshotIntervalMin: normalizeScreenshotIntervalMin(
        current.defaultScreenshotIntervalMin,
        WORKSPACE_POLICY_DEFAULTS.defaultScreenshotIntervalMin,
      ),
      idleThresholdMin: current.defaultIdleThresholdMin,
    };
    const nextTiming = {
      screenshotIntervalMin: updateData.defaultScreenshotIntervalMin ?? previousTiming.screenshotIntervalMin,
      idleThresholdMin: updateData.defaultIdleThresholdMin ?? current.defaultIdleThresholdMin,
    };
    if (nextTiming.idleThresholdMin !== previousTiming.idleThresholdMin) {
      const incompatibleWarnings = await prisma.user.count({
        where: {
          workspaceId: req.scope.workspaceId,
          idleThresholdMin: null,
          idleWarningSeconds: { gte: nextTiming.idleThresholdMin * 60 },
        },
      });
      if (incompatibleWarnings > 0) {
        return res.status(400).json({
          error: 'idle_warning_requires_higher_threshold',
          affectedUsers: incompatibleWarnings,
        });
      }
    }
    const timingChanged = monitoringTimingChanged(previousTiming, nextTiming);
    const riskLevel = monitoringRiskLevel(nextTiming);
    const auditReason = normalizeAuditReason(rawAuditReason);
    if (timingChanged && riskLevel === 'HIGH' && !auditReason) {
      return res.status(400).json({ error: 'missing_monitoring_audit_reason' });
    }

    const workspaceId = req.scope.workspaceId;
    const actorId = req.user.sub;
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.workspacePolicy.update({
        where: { workspaceId },
        data: updateData,
      });
      if (timingChanged) {
        await tx.monitoringSettingsAudit.create({
          data: {
            workspaceId,
            actorId,
            scope: 'WORKSPACE_POLICY',
            previousScreenshotIntervalMin: previousTiming.screenshotIntervalMin,
            previousIdleThresholdMin: previousTiming.idleThresholdMin,
            nextScreenshotIntervalMin: nextTiming.screenshotIntervalMin,
            nextIdleThresholdMin: nextTiming.idleThresholdMin,
            riskLevel,
            reason: auditReason,
          },
        });
      }
      return updated;
    });
    res.json(toDto(row));
  } catch (err) {
    next(err);
  }
});

export default workspacePolicyRouter;
