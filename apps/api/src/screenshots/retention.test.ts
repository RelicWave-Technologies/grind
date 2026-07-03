import { describe, expect, it } from 'vitest';
import { prisma } from '@grind/db';
import { runScreenshotRetentionOnce, type ScreenshotTrashFn } from './retention';

let counter = 0;

async function seedWorkspace(input: { retentionDays?: number | null } = {}) {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const workspace = await prisma.workspace.create({ data: { name: `Screenshot retention ${stamp}` } });
  if (input.retentionDays !== null) {
    await prisma.workspacePolicy.create({
      data: {
        workspaceId: workspace.id,
        retentionDaysScreenshots: input.retentionDays ?? 30,
      },
    });
  }
  const user = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: `retention-${stamp}@test.local`,
      name: 'Retention User',
      role: 'MEMBER',
      passwordHash: 'x'.repeat(60),
    },
  });
  return { workspace, user };
}

async function seedShot(input: {
  userId: string;
  id: string;
  capturedAt: Date;
  uploadState?: 'PENDING' | 'UPLOADED' | 'FAILED';
  s3Key?: string | null;
  thumbS3Key?: string | null;
  deletedAt?: Date | null;
  deletedReason?: string | null;
}) {
  return prisma.screenshot.create({
    data: {
      id: input.id,
      userId: input.userId,
      capturedAt: input.capturedAt,
      uploadState: input.uploadState ?? 'UPLOADED',
      s3Key: input.s3Key ?? `${input.id}-full`,
      thumbS3Key: input.thumbS3Key ?? null,
      fullUrl: `https://timo.test/${input.id}`,
      thumbUrl: `https://timo.test/${input.id}-thumb`,
      deletedAt: input.deletedAt ?? null,
      deletedReason: input.deletedReason ?? null,
    },
  });
}

describe('screenshot retention', () => {
  it('soft-deletes expired uploaded screenshots and finalizes storage cleanup', async () => {
    const now = new Date('2026-07-03T00:00:00.000Z');
    const { user } = await seedWorkspace({ retentionDays: 30 });
    const disabled = await seedWorkspace({ retentionDays: 0 });
    const defaultPolicy = await seedWorkspace({ retentionDays: null });
    const trashed: string[] = [];
    const trash: ScreenshotTrashFn = async (fileId) => {
      trashed.push(fileId);
      return fileId.includes('missing') ? 'missing' : 'trashed';
    };

    await seedShot({
      userId: user.id,
      id: 'expired',
      capturedAt: new Date('2026-05-30T00:00:00.000Z'),
      s3Key: 'drive-full',
      thumbS3Key: 'drive-thumb',
    });
    await seedShot({
      userId: user.id,
      id: 'expired-missing',
      capturedAt: new Date('2026-05-30T00:00:00.000Z'),
      s3Key: 'drive-missing',
    });
    await seedShot({ userId: user.id, id: 'recent', capturedAt: new Date('2026-06-20T00:00:00.000Z') });
    await seedShot({
      userId: user.id,
      id: 'pending-old',
      capturedAt: new Date('2026-05-30T00:00:00.000Z'),
      uploadState: 'PENDING',
    });
    await seedShot({
      userId: disabled.user.id,
      id: 'disabled-old',
      capturedAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    await seedShot({
      userId: defaultPolicy.user.id,
      id: 'default-old',
      capturedAt: new Date('2026-04-30T00:00:00.000Z'),
    });

    const result = await runScreenshotRetentionOnce(now, trash);

    expect(result.checkedWorkspaces).toBe(3);
    expect(result.skippedDisabledWorkspaces).toBe(1);
    expect(result.rowsSoftDeleted).toBe(3);
    expect(result.rowsFinalized).toBe(3);
    expect(result.driveFilesTrashed).toBe(3);
    expect(result.driveFilesMissing).toBe(1);
    expect(trashed.sort()).toEqual(['default-old-full', 'drive-full', 'drive-missing', 'drive-thumb'].sort());

    const rows = await prisma.screenshot.findMany({ orderBy: { id: 'asc' } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('expired')?.deletedReason).toBe('retention_expired');
    expect(byId.get('expired')?.deletedAt).toBeTruthy();
    expect(byId.get('expired')?.s3Key).toBeNull();
    expect(byId.get('default-old')?.deletedAt).toBeTruthy();
    expect(byId.get('recent')?.deletedAt).toBeNull();
    expect(byId.get('pending-old')?.deletedAt).toBeNull();
    expect(byId.get('disabled-old')?.deletedAt).toBeNull();
  });

  it('keeps storage keys for retry when trashing fails, then finalizes on the next run', async () => {
    const now = new Date('2026-07-03T00:00:00.000Z');
    const { user } = await seedWorkspace({ retentionDays: 30 });
    await seedShot({
      userId: user.id,
      id: 'retry-me',
      capturedAt: new Date('2026-05-30T00:00:00.000Z'),
      s3Key: 'retry-full',
    });

    const first = await runScreenshotRetentionOnce(now, async () => {
      throw new Error('drive down');
    });
    let row = await prisma.screenshot.findUniqueOrThrow({ where: { id: 'retry-me' } });
    expect(first.rowsSoftDeleted).toBe(1);
    expect(first.rowsFinalized).toBe(0);
    expect(first.driveTrashFailures).toBe(1);
    expect(row.deletedReason).toBe('retention_expired');
    expect(row.deletedAt).toBeTruthy();
    expect(row.s3Key).toBe('retry-full');

    const retried: string[] = [];
    const second = await runScreenshotRetentionOnce(now, async (fileId) => {
      retried.push(fileId);
      return 'trashed';
    });
    row = await prisma.screenshot.findUniqueOrThrow({ where: { id: 'retry-me' } });
    expect(second.rowsSoftDeleted).toBe(0);
    expect(second.retriedDeletedScreenshots).toBe(1);
    expect(second.rowsFinalized).toBe(1);
    expect(retried).toEqual(['retry-full']);
    expect(row.s3Key).toBeNull();
    expect(row.fullUrl).toBeNull();
  });
});

