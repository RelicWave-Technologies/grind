import { describe, expect, it } from 'vitest';
import { prisma } from '@grind/db';
import {
  applyLegacyReconciliationPlan,
  buildLegacyReconciliationPlan,
} from '../src/timeLifecycle/legacyReconciliation';
import { fakeUlid, seedUser } from './helpers';

const now = new Date('2026-07-13T12:00:00.000Z');

async function createLegacyEntry(args: {
  userId: string;
  startedAt?: Date;
  sampleAt?: Date;
  screenshotAt?: Date;
  activePointer?: string | null;
}) {
  const startedAt = args.startedAt ?? new Date('2026-07-13T10:00:00.000Z');
  const entryId = fakeUlid('legacy-entry');
  await prisma.timeEntry.create({
    data: {
      id: entryId,
      clientUuid: fakeUlid('legacy-client'),
      userId: args.userId,
      source: 'AUTO',
      startedAt,
      endedAt: null,
      segments: {
        create: {
          id: fakeUlid('legacy-segment'),
          kind: 'WORK',
          startedAt,
          endedAt: null,
        },
      },
    },
  });
  if (args.sampleAt) {
    await prisma.activitySample.create({
      data: {
        id: fakeUlid('legacy-sample'),
        userId: args.userId,
        timeEntryId: entryId,
        bucketStart: args.sampleAt,
        keystrokes: 1,
        clicks: 1,
        mouseDistancePx: 1,
        scrollEvents: 0,
      },
    });
  }
  if (args.screenshotAt) {
    await prisma.screenshot.create({
      data: {
        id: fakeUlid('legacy-screenshot'),
        userId: args.userId,
        timeEntryId: entryId,
        capturedAt: args.screenshotAt,
      },
    });
  }
  await prisma.user.update({
    where: { id: args.userId },
    data: { agentActiveEntryId: args.activePointer === undefined ? entryId : args.activePointer },
  });
  return entryId;
}

describe('legacy timer reconciliation', () => {
  it('dry-runs at the latest evidence boundary without mutating data', async () => {
    const user = await seedUser();
    const entryId = await createLegacyEntry({
      userId: user.userId,
      sampleAt: new Date('2026-07-13T10:20:00.000Z'),
    });

    const plan = await buildLegacyReconciliationPlan({ now });

    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      entryId,
      proposedEndedAt: '2026-07-13T10:21:00.000Z',
      latestActivitySampleAt: '2026-07-13T10:20:00.000Z',
      openSegmentCount: 1,
      reconciledDurationMs: 21 * 60_000,
    });
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/u);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } })).endedAt).toBeNull();
  });

  it('preserves work proven by a linked screenshot', async () => {
    const user = await seedUser();
    const entryId = await createLegacyEntry({
      userId: user.userId,
      screenshotAt: new Date('2026-07-13T10:00:21.000Z'),
    });

    const plan = await buildLegacyReconciliationPlan({ now });

    expect(plan.version).toBe(3);
    expect(plan.entries).toEqual([
      expect.objectContaining({
        entryId,
        proposedEndedAt: '2026-07-13T10:00:21.000Z',
        latestScreenshotAt: '2026-07-13T10:00:21.000Z',
        reconciledDurationMs: 21_000,
      }),
    ]);
  });

  it('preserves time proven by a matching running heartbeat', async () => {
    const user = await seedUser();
    const entryId = await createLegacyEntry({
      userId: user.userId,
      screenshotAt: new Date('2026-07-13T10:00:21.000Z'),
    });
    const heartbeatAt = new Date('2026-07-13T10:02:00.000Z');
    await prisma.user.update({
      where: { id: user.userId },
      data: { agentState: 'RUNNING', agentLastSeenAt: heartbeatAt },
    });

    const plan = await buildLegacyReconciliationPlan({ now });

    expect(plan.entries).toEqual([
      expect.objectContaining({
        entryId,
        proposedEndedAt: heartbeatAt.toISOString(),
        latestRunningHeartbeatAt: heartbeatAt.toISOString(),
        reconciledDurationMs: 2 * 60_000,
      }),
    ]);
  });

  it('does not count a paused heartbeat as work evidence', async () => {
    const user = await seedUser();
    const entryId = await createLegacyEntry({ userId: user.userId });
    await prisma.user.update({
      where: { id: user.userId },
      data: {
        agentState: 'PAUSED_IDLE',
        agentLastSeenAt: new Date('2026-07-13T10:02:00.000Z'),
      },
    });

    const plan = await buildLegacyReconciliationPlan({ now });

    expect(plan.entries).toEqual([
      expect.objectContaining({
        entryId,
        proposedEndedAt: '2026-07-13T10:00:00.000Z',
        latestRunningHeartbeatAt: null,
        reconciledDurationMs: 0,
      }),
    ]);
  });

  it('applies only the reviewed hash and clears the matching pointer', async () => {
    const user = await seedUser();
    const entryId = await createLegacyEntry({
      userId: user.userId,
      sampleAt: new Date('2026-07-13T10:20:00.000Z'),
    });
    const plan = await buildLegacyReconciliationPlan({ now });

    await expect(applyLegacyReconciliationPlan({ planHash: plan.planHash, now })).resolves.toEqual({
      applied: 1,
      repairedPointers: 0,
      planHash: plan.planHash,
    });
    const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId }, include: { segments: true } });
    expect(entry.endedAt?.toISOString()).toBe('2026-07-13T10:21:00.000Z');
    expect(entry.segments[0]?.endedAt?.toISOString()).toBe('2026-07-13T10:21:00.000Z');
    expect(entry.closeReason).toBe('LEGACY_RECONCILED');
    expect(entry.serverFinalizedAt?.toISOString()).toBe(now.toISOString());
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).agentActiveEntryId).toBeNull();
  });

  it('skips a user with a fresh heartbeat', async () => {
    const user = await seedUser();
    const entryId = await createLegacyEntry({ userId: user.userId });
    await prisma.user.update({
      where: { id: user.userId },
      data: { agentLastSeenAt: new Date(now.getTime() - 60_000) },
    });

    const plan = await buildLegacyReconciliationPlan({ now });

    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped).toEqual([{ entryId, userId: user.userId, reason: 'FRESH_HEARTBEAT' }]);
  });

  it('rejects apply when evidence changed after the reviewed dry run', async () => {
    const user = await seedUser();
    const entryId = await createLegacyEntry({ userId: user.userId });
    const plan = await buildLegacyReconciliationPlan({ now });
    await prisma.activitySample.create({
      data: {
        id: fakeUlid('late-sample'),
        userId: user.userId,
        timeEntryId: entryId,
        bucketStart: new Date('2026-07-13T10:30:00.000Z'),
        keystrokes: 1,
        clicks: 1,
        mouseDistancePx: 1,
        scrollEvents: 0,
      },
    });

    await expect(applyLegacyReconciliationPlan({ planHash: plan.planHash, now }))
      .rejects.toThrow('legacy_reconciliation_plan_changed');
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } })).endedAt).toBeNull();
  });

  it('rejects apply when screenshot evidence arrives after the reviewed dry run', async () => {
    const user = await seedUser();
    const entryId = await createLegacyEntry({ userId: user.userId });
    const plan = await buildLegacyReconciliationPlan({ now });
    await prisma.screenshot.create({
      data: {
        id: fakeUlid('late-screenshot'),
        userId: user.userId,
        timeEntryId: entryId,
        capturedAt: new Date('2026-07-13T10:00:21.000Z'),
      },
    });

    await expect(applyLegacyReconciliationPlan({ planHash: plan.planHash, now }))
      .rejects.toThrow('legacy_reconciliation_plan_changed');
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } })).endedAt).toBeNull();
  });

  it('preserves a pointer that already moved to another entry', async () => {
    const user = await seedUser();
    const newerEntryId = fakeUlid('newer-v2-entry');
    await prisma.timeEntry.create({
      data: {
        id: newerEntryId,
        clientUuid: fakeUlid('newer-v2-client'),
        userId: user.userId,
        source: 'AUTO',
        startedAt: new Date('2026-07-13T11:30:00.000Z'),
        trackingProtocolVersion: 2,
        agentRevision: 1,
        lastProvenAt: now,
        leaseExpiresAt: new Date(now.getTime() + 3 * 60_000),
      },
    });
    const entryId = await createLegacyEntry({ userId: user.userId, activePointer: newerEntryId });
    const plan = await buildLegacyReconciliationPlan({ now });

    await applyLegacyReconciliationPlan({ planHash: plan.planHash, now });

    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } })).endedAt).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).agentActiveEntryId).toBe(newerEntryId);
  });

  it('repairs a reviewed pointer to an already-closed entry without deleting history', async () => {
    const user = await seedUser();
    const entryId = fakeUlid('closed-pointer-entry');
    const startedAt = new Date('2026-07-13T10:00:00.000Z');
    const endedAt = new Date('2026-07-13T10:10:00.000Z');
    await prisma.timeEntry.create({
      data: {
        id: entryId,
        clientUuid: fakeUlid('closed-pointer-client'),
        userId: user.userId,
        source: 'AUTO',
        startedAt,
        endedAt,
      },
    });
    await prisma.user.update({ where: { id: user.userId }, data: { agentActiveEntryId: entryId } });

    const plan = await buildLegacyReconciliationPlan({ now });
    expect(plan.entries).toHaveLength(0);
    expect(plan.pointerRepairs).toEqual([
      expect.objectContaining({
        userId: user.userId,
        staleEntryId: entryId,
        reason: 'CLOSED_ENTRY',
        staleEntryEndedAt: endedAt.toISOString(),
      }),
    ]);

    await expect(applyLegacyReconciliationPlan({ planHash: plan.planHash, now })).resolves.toEqual({
      applied: 0,
      repairedPointers: 1,
      planHash: plan.planHash,
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).agentActiveEntryId).toBeNull();
    expect(await prisma.timeEntry.findUnique({ where: { id: entryId } })).not.toBeNull();
  });
});
