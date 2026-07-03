import { prisma } from '@grind/db';
import { WORKSPACE_POLICY_DEFAULTS } from '@grind/types';
import { env } from '../env';
import { isGoogleDriveConfigured, trashScreenshotInDrive } from '../lib/googleDrive';
import { logger } from '../logger';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;
const BATCH_SIZE = 100;
const DAY_MS = 86_400_000;
const RETENTION_REASON = 'retention_expired';

export type ScreenshotTrashResult = 'trashed' | 'missing';
export type ScreenshotTrashFn = (fileId: string) => Promise<ScreenshotTrashResult>;

export interface ScreenshotRetentionResult {
  checkedWorkspaces: number;
  skippedDisabledWorkspaces: number;
  scannedScreenshots: number;
  newlyExpiredScreenshots: number;
  retriedDeletedScreenshots: number;
  rowsSoftDeleted: number;
  rowsFinalized: number;
  driveFilesTrashed: number;
  driveFilesMissing: number;
  driveTrashFailures: number;
}

interface RetentionRow {
  id: string;
  deletedAt: Date | null;
  s3Key: string | null;
  thumbS3Key: string | null;
}

export function startScreenshotRetentionScheduler(): void {
  if (env.NODE_ENV === 'test') return;
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try {
      const result = await runScreenshotRetentionOnce();
      if (result.rowsSoftDeleted || result.rowsFinalized || result.driveTrashFailures) {
        logger.info(result, 'screenshot retention completed');
      }
    } catch (err) {
      logger.warn({ err }, 'screenshot retention scheduler failed');
    } finally {
      active = false;
    }
  };
  const handle = setInterval(tick, CHECK_INTERVAL_MS);
  handle.unref?.();
  setTimeout(tick, INITIAL_DELAY_MS).unref?.();
}

export async function runScreenshotRetentionOnce(
  now = new Date(),
  trashFile: ScreenshotTrashFn | null = isGoogleDriveConfigured() ? trashScreenshotInDrive : null,
): Promise<ScreenshotRetentionResult> {
  const workspaces = await prisma.workspace.findMany({
    select: {
      id: true,
      policy: { select: { retentionDaysScreenshots: true } },
    },
  });
  const result: ScreenshotRetentionResult = {
    checkedWorkspaces: workspaces.length,
    skippedDisabledWorkspaces: 0,
    scannedScreenshots: 0,
    newlyExpiredScreenshots: 0,
    retriedDeletedScreenshots: 0,
    rowsSoftDeleted: 0,
    rowsFinalized: 0,
    driveFilesTrashed: 0,
    driveFilesMissing: 0,
    driveTrashFailures: 0,
  };

  for (const workspace of workspaces) {
    const retentionDays = workspace.policy?.retentionDaysScreenshots ?? WORKSPACE_POLICY_DEFAULTS.retentionDaysScreenshots;
    if (retentionDays <= 0) {
      result.skippedDisabledWorkspaces += 1;
      continue;
    }
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    await processWorkspace(workspace.id, cutoff, trashFile, result);
  }

  return result;
}

async function processWorkspace(
  workspaceId: string,
  cutoff: Date,
  trashFile: ScreenshotTrashFn | null,
  result: ScreenshotRetentionResult,
): Promise<void> {
  const processedIds = new Set<string>();
  for (;;) {
    const rows = await prisma.screenshot.findMany({
      where: {
        ...(processedIds.size > 0 ? { id: { notIn: [...processedIds] } } : {}),
        user: { workspaceId },
        uploadState: 'UPLOADED',
        OR: [
          { deletedAt: null, capturedAt: { lt: cutoff } },
          {
            deletedReason: RETENTION_REASON,
            OR: [{ s3Key: { not: null } }, { thumbS3Key: { not: null } }],
          },
        ],
      },
      select: {
        id: true,
        deletedAt: true,
        s3Key: true,
        thumbS3Key: true,
      },
      orderBy: { capturedAt: 'asc' },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) return;

    result.scannedScreenshots += rows.length;
    result.newlyExpiredScreenshots += rows.filter((row) => row.deletedAt === null).length;
    result.retriedDeletedScreenshots += rows.filter((row) => row.deletedAt !== null).length;

    for (const row of rows) {
      await processScreenshot(row, trashFile, result);
      processedIds.add(row.id);
    }
  }
}

async function processScreenshot(
  row: RetentionRow,
  trashFile: ScreenshotTrashFn | null,
  result: ScreenshotRetentionResult,
): Promise<void> {
  if (!row.deletedAt) {
    await prisma.screenshot.update({
      where: { id: row.id },
      data: {
        deletedAt: new Date(),
        deletedReason: RETENTION_REASON,
      },
    });
    result.rowsSoftDeleted += 1;
  }

  const fileIds = [...new Set([row.s3Key, row.thumbS3Key].filter((value): value is string => Boolean(value)))];
  if (trashFile && fileIds.length > 0) {
    let failed = false;
    for (const fileId of fileIds) {
      try {
        const outcome = await trashFile(fileId);
        if (outcome === 'missing') result.driveFilesMissing += 1;
        else result.driveFilesTrashed += 1;
      } catch (err) {
        failed = true;
        result.driveTrashFailures += 1;
        logger.warn({ err, screenshotId: row.id, fileId }, 'screenshot retention failed to trash storage object');
      }
    }
    if (failed) return;
  }

  await prisma.screenshot.update({
    where: { id: row.id },
    data: {
      s3Key: null,
      thumbS3Key: null,
      fullUrl: null,
      thumbUrl: null,
    },
  });
  result.rowsFinalized += 1;
}
