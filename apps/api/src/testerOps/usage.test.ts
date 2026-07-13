import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@grind/db';
import { buildTesterUsageSnapshot } from './usage';

let counter = 0;

async function seedTester(name = 'Tester') {
  counter += 1;
  const workspace = await prisma.workspace.create({ data: { name: `Tester Ops ${counter}` } });
  const user = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: `tester-${counter}@test.local`,
      name,
      role: 'MEMBER',
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
      agentState: 'RUNNING',
      agentLastSeenAt: new Date(),
    },
  });
  return { workspace, user };
}

async function createEntry(args: {
  userId: string;
  id: string;
  startedAt: string;
  endedAt?: string | null;
  segments: Array<{
    id: string;
    kind?: 'WORK' | 'MEETING' | 'IDLE_TRIMMED';
    startedAt: string;
    endedAt?: string | null;
  }>;
}) {
  return prisma.timeEntry.create({
    data: {
      id: args.id,
      clientUuid: `${args.id}-client`,
      userId: args.userId,
      source: 'AUTO',
      startedAt: new Date(args.startedAt),
      endedAt: args.endedAt === undefined || args.endedAt === null ? null : new Date(args.endedAt),
      segments: {
        create: args.segments.map((segment) => ({
          id: segment.id,
          kind: segment.kind ?? 'WORK',
          startedAt: new Date(segment.startedAt),
          endedAt: segment.endedAt === undefined || segment.endedAt === null ? null : new Date(segment.endedAt),
        })),
      },
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('buildTesterUsageSnapshot', () => {
  it('does not count a stale open entry into today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T09:34:00.000Z'));
    const { workspace, user } = await seedTester('Tamanna Regression');

    await createEntry({
      userId: user.id,
      id: 'old-open-entry',
      startedAt: '2026-07-07T04:10:30.226Z',
      endedAt: null,
      segments: [{
        id: 'old-open-segment',
        startedAt: '2026-07-07T04:10:30.226Z',
        endedAt: null,
      }],
    });

    const snapshot = await buildTesterUsageSnapshot(workspace.id, 'Asia/Kolkata');
    expect(snapshot.date).toBe('2026-07-10');
    expect(snapshot.testers).toHaveLength(1);
    expect(snapshot.testers[0]?.trackedMinutes).toBe(0);
  });

  it('counts work segments, excludes trimmed idle, and keeps fresh work live', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T09:34:00.000Z'));
    const { workspace, user } = await seedTester('Segment Source');

    await createEntry({
      userId: user.id,
      id: 'closed-entry-with-gap',
      startedAt: '2026-07-10T05:00:00.000Z',
      endedAt: '2026-07-10T07:00:00.000Z',
      segments: [
        { id: 'work-1', startedAt: '2026-07-10T05:00:00.000Z', endedAt: '2026-07-10T05:30:00.000Z' },
        { id: 'idle-1', kind: 'IDLE_TRIMMED', startedAt: '2026-07-10T05:30:00.000Z', endedAt: '2026-07-10T06:00:00.000Z' },
        { id: 'work-2', startedAt: '2026-07-10T06:30:00.000Z', endedAt: '2026-07-10T07:00:00.000Z' },
      ],
    });
    await createEntry({
      userId: user.id,
      id: 'fresh-open-entry',
      startedAt: '2026-07-10T09:20:00.000Z',
      endedAt: null,
      segments: [{ id: 'fresh-open-segment', startedAt: '2026-07-10T09:20:00.000Z', endedAt: null }],
    });
    await prisma.activitySample.create({
      data: {
        id: 'fresh-open-sample',
        userId: user.id,
        timeEntryId: 'fresh-open-entry',
        bucketStart: new Date('2026-07-10T09:33:00.000Z'),
        keystrokes: 1,
        clicks: 1,
        mouseDistancePx: 1,
        scrollEvents: 0,
      },
    });

    const snapshot = await buildTesterUsageSnapshot(workspace.id, 'Asia/Kolkata');
    expect(snapshot.testers[0]?.trackedMinutes).toBe(74);
  });
});
