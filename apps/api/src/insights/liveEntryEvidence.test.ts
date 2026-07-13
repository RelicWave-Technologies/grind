import { describe, expect, it } from 'vitest';
import { prisma } from '@grind/db';
import { heartbeatIsFresh, loadEntryLiveEvidence, trustedObservedAt } from './liveEntryEvidence';

async function seedOpenEntry(id: string) {
  const workspace = await prisma.workspace.create({ data: { name: `Evidence ${id}` } });
  const user = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: `${id}@test.local`,
      name: id,
      role: 'MEMBER',
      provisioningStatus: 'ACTIVE',
      passwordHash: 'x'.repeat(60),
    },
  });
  const entry = await prisma.timeEntry.create({
    data: {
      id,
      clientUuid: `${id}-client`,
      userId: user.id,
      source: 'AUTO',
      startedAt: new Date('2026-07-13T09:00:00.000Z'),
      segments: {
        create: { id: `${id}-segment`, startedAt: new Date('2026-07-13T09:00:00.000Z') },
      },
    },
  });
  return { workspace, user, entry };
}

describe('trustedObservedAt', () => {
  const now = new Date('2026-07-13T10:00:00.000Z');

  it('rejects proof beyond the allowed client clock skew', () => {
    expect(trustedObservedAt({
      observedAt: new Date('2026-07-13T10:03:00.000Z'),
      receivedAt: now,
      now,
    })).toBeNull();
  });

  it('never proves later than the server receipt time', () => {
    expect(trustedObservedAt({
      observedAt: new Date('2026-07-13T10:01:00.000Z'),
      receivedAt: now,
      now: new Date('2026-07-13T10:01:30.000Z'),
    })?.toISOString()).toBe(now.toISOString());
  });
});

describe('heartbeatIsFresh', () => {
  const now = new Date('2026-07-13T10:00:00.000Z');

  it('accepts the three-minute boundary and rejects older or future heartbeats', () => {
    const evidenceAt = (timestamp: string) => ({
      latestStoredProofAt: null,
      latestHeartbeatAt: new Date(timestamp),
    });

    expect(heartbeatIsFresh(evidenceAt('2026-07-13T09:57:00.000Z'), now)).toBe(true);
    expect(heartbeatIsFresh(evidenceAt('2026-07-13T09:56:59.999Z'), now)).toBe(false);
    expect(heartbeatIsFresh(evidenceAt('2026-07-13T10:00:00.001Z'), now)).toBe(false);
    expect(heartbeatIsFresh(
      evidenceAt('2026-07-13T09:59:00.000Z'),
      now,
      new Date('2026-07-13T09:59:00.001Z'),
    )).toBe(false);
  });
});

describe('loadEntryLiveEvidence', () => {
  const now = new Date('2026-07-13T10:00:00.000Z');

  it('uses a fresh exact-entry heartbeat when screenshots are disabled', async () => {
    const { user, entry } = await seedOpenEntry('heartbeat-only');
    const heartbeat = new Date('2026-07-13T09:59:00.000Z');
    await prisma.user.update({
      where: { id: user.id },
      data: { agentState: 'RUNNING', agentActiveEntryId: entry.id, agentLastSeenAt: heartbeat },
    });

    const evidence = await loadEntryLiveEvidence([entry], now);
    expect(evidence.get(entry.id)).toEqual({ latestStoredProofAt: null, latestHeartbeatAt: heartbeat });
  });

  it('keeps a stale heartbeat as exact proof and rejects the wrong owner', async () => {
    const { workspace, user, entry } = await seedOpenEntry('heartbeat-owner');
    await prisma.user.update({
      where: { id: user.id },
      data: {
        agentState: 'RUNNING',
        agentActiveEntryId: entry.id,
        agentLastSeenAt: new Date('2026-07-13T09:56:59.000Z'),
      },
    });
    const other = await prisma.user.create({
      data: {
        workspaceId: workspace.id,
        email: 'wrong-owner@test.local',
        name: 'Wrong owner',
        role: 'MEMBER',
        provisioningStatus: 'ACTIVE',
        passwordHash: 'x'.repeat(60),
        agentState: 'RUNNING',
        agentActiveEntryId: entry.id,
        agentLastSeenAt: new Date('2026-07-13T09:59:00.000Z'),
      },
    });
    expect(other.id).not.toBe(user.id);

    const evidence = await loadEntryLiveEvidence([entry], now);
    expect(evidence.get(entry.id)?.latestHeartbeatAt?.toISOString()).toBe('2026-07-13T09:56:59.000Z');
  });

  it('ignores a far-future screenshot and falls back to valid server-bounded proof', async () => {
    const { user, entry } = await seedOpenEntry('future-proof');
    await prisma.screenshot.createMany({
      data: [
        {
          id: 'valid-shot',
          userId: user.id,
          timeEntryId: entry.id,
          capturedAt: new Date('2026-07-13T09:50:00.000Z'),
          createdAt: new Date('2026-07-13T09:50:05.000Z'),
        },
        {
          id: 'future-shot',
          userId: user.id,
          timeEntryId: entry.id,
          capturedAt: new Date('2026-07-14T10:00:00.000Z'),
          createdAt: now,
        },
      ],
    });

    const evidence = await loadEntryLiveEvidence([entry], now);
    expect(evidence.get(entry.id)?.latestStoredProofAt?.toISOString()).toBe('2026-07-13T09:50:00.000Z');
  });

  it('uses the latest safe screenshot or activity proof', async () => {
    const { user, entry } = await seedOpenEntry('stored-proof');
    await prisma.screenshot.create({
      data: {
        id: 'older-shot',
        userId: user.id,
        timeEntryId: entry.id,
        capturedAt: new Date('2026-07-13T09:57:00.000Z'),
        createdAt: new Date('2026-07-13T09:57:05.000Z'),
      },
    });
    await prisma.activitySample.create({
      data: {
        id: 'newer-sample',
        userId: user.id,
        timeEntryId: entry.id,
        bucketStart: new Date('2026-07-13T09:58:00.000Z'),
        createdAt: new Date('2026-07-13T09:59:05.000Z'),
        keystrokes: 1,
        clicks: 1,
        mouseDistancePx: 1,
        scrollEvents: 0,
      },
    });

    const evidence = await loadEntryLiveEvidence([entry], now);
    expect(evidence.get(entry.id)?.latestStoredProofAt?.toISOString()).toBe('2026-07-13T09:59:00.000Z');
  });
});
