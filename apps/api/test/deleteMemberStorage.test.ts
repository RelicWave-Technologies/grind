import { describe, expect, it } from 'vitest';
import { prisma } from '@grind/db';
import { deleteMember } from '../src/admin/deleteMember';
import { fakeUlid, seedUser } from './helpers';

/**
 * Deleting a long-serving member: their samples are removed in batches before
 * the transaction (which used to time out at 5s), and their screenshot files
 * are moved to the Drive trash afterwards, best-effort.
 */

async function seedPair() {
  const admin = await seedUser({ role: 'ADMIN' });
  const victim = await prisma.user.create({
    data: {
      workspaceId: admin.workspaceId,
      email: `victim-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      name: 'Victim',
      role: 'MEMBER',
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
    },
  });
  return { admin, victim };
}

describe('deleteMember at size', () => {
  it('removes more samples than one batch and trashes each Drive file once', async () => {
    const { admin, victim } = await seedPair();
    const base = Date.parse('2025-01-01T00:00:00Z');
    const samples = Array.from({ length: 12_050 }, (_, i) => ({
      id: `as_${victim.id}_${i}`,
      userId: victim.id,
      bucketStart: new Date(base + i * 60_000),
      keystrokes: 1,
      clicks: 0,
      mouseDistancePx: 0,
      scrollEvents: 0,
    }));
    await prisma.activitySample.createMany({ data: samples });
    await prisma.screenshot.create({
      data: { id: fakeUlid('ss'), userId: victim.id, capturedAt: new Date(base), s3Key: 'drive-a', thumbS3Key: 'drive-a-thumb' },
    });
    await prisma.screenshot.create({
      data: { id: fakeUlid('ss'), userId: victim.id, capturedAt: new Date(base + 60_000), s3Key: 'drive-b' },
    });
    // An unrelated colleague's file must not be touched.
    await prisma.screenshot.create({
      data: { id: fakeUlid('ss'), userId: admin.userId, capturedAt: new Date(base), s3Key: 'drive-colleague' },
    });

    const trashed: string[] = [];
    const result = await deleteMember({
      workspaceId: admin.workspaceId,
      userId: victim.id,
      actorId: admin.userId,
      trashFile: async (id) => {
        trashed.push(id);
        if (id === 'drive-b') throw new Error('drive 500');
        return id === 'drive-a-thumb' ? 'missing' : 'trashed';
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.destroys.activitySamples).toBe(12_050);
    expect(result.storage).toEqual({ driveFilesTrashed: 1, driveFilesMissing: 1, driveTrashFailures: 1 });
    expect(trashed.sort()).toEqual(['drive-a', 'drive-a-thumb', 'drive-b']);
    expect(await prisma.user.count({ where: { id: victim.id } })).toBe(0);
    expect(await prisma.activitySample.count({ where: { userId: victim.id } })).toBe(0);
    expect(await prisma.screenshot.count({ where: { userId: victim.id } })).toBe(0);
    expect(await prisma.screenshot.count({ where: { userId: admin.userId } })).toBe(1);
  });

  it('touches no storage when no trash function is configured', async () => {
    const { admin, victim } = await seedPair();
    await prisma.screenshot.create({
      data: { id: fakeUlid('ss'), userId: victim.id, capturedAt: new Date(), s3Key: 'cloudinary/x' },
    });
    const result = await deleteMember({ workspaceId: admin.workspaceId, userId: victim.id, actorId: admin.userId, trashFile: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.storage).toEqual({ driveFilesTrashed: 0, driveFilesMissing: 0, driveTrashFailures: 0 });
    expect(result.plan.orphanedScreenshotFiles).toBe(1);
  });
});
