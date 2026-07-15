import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { reconcileExpiredTimersOnce, TIMER_LEASE_MS } from '../src/timeLifecycle';
import { fakeUlid, seedUser } from './helpers';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function v2Body(startedAt: Date, revision = 1) {
  const id = fakeUlid('lease-entry');
  return {
    id,
    clientUuid: fakeUlid('lease-client'),
    source: 'AUTO',
    trackingProtocolVersion: 2,
    revision,
    observedAt: startedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    endedAt: null,
    closeReason: null,
    agentVersion: '0.0.2-beta.26',
    platform: 'darwin',
    segments: [{ id: fakeUlid('lease-segment'), kind: 'WORK', startedAt: startedAt.toISOString(), endedAt: null }],
  };
}

describe('timer lifecycle protocol v2', () => {
  it('creates a leased entry and renews it from a matching heartbeat checkpoint', async () => {
    const user = await seedUser();
    const startedAt = new Date(Date.now() - 60_000);
    const body = v2Body(startedAt);
    const created = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ disposition: 'APPLIED', acceptedRevision: 1 });
    expect(created.body.canonicalEntry.trackingProtocolVersion).toBe(2);
    expect(created.body.canonicalEntry.revision).toBe(1);
    expect(created.body.canonicalEntry.leaseExpiresAt).toEqual(expect.any(String));

    const before = new Date(created.body.canonicalEntry.leaseExpiresAt).getTime();
    const monotonicProof = new Date();
    await prisma.timeEntry.update({ where: { id: body.id }, data: { lastProvenAt: monotonicProof } });
    const heartbeat = await request(app).post('/v1/agent/heartbeat').set(bearer(user.accessToken)).send({
      agentVersion: '0.0.2-beta.26',
      platform: 'darwin',
      state: 'RUNNING',
      activeEntryId: body.id,
      trackingProtocolVersion: 2,
      timerCheckpoint: {
        entryId: body.id,
        revision: 1,
        state: 'RUNNING',
        observedAt: startedAt.toISOString(),
      },
    });

    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.timer).toMatchObject({ disposition: 'accepted', entryId: body.id, serverRevision: 1 });
    const row = await prisma.timeEntry.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.lastProvenAt?.toISOString()).toBe(monotonicProof.toISOString());
  });

  it('replays an identical clock-clamped create after its first response is lost', async () => {
    const user = await seedUser();
    const body = v2Body(new Date(Date.now() + 45 * 60_000));

    const first = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ disposition: 'APPLIED', correction: 'CLOCK_CLAMP' });

    const retry = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      disposition: 'ALREADY_APPLIED',
      canonicalHash: first.body.canonicalHash,
    });
  });

  it('finalizes an expired lease once even when two workers race', async () => {
    const user = await seedUser();
    const provenAt = new Date(Date.now() - 4 * 60_000);
    const body = v2Body(new Date(Date.now() - 10 * 60_000));
    await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    await prisma.timeEntry.update({
      where: { id: body.id },
      data: { lastProvenAt: provenAt, leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await prisma.user.update({ where: { id: user.userId }, data: { agentActiveEntryId: body.id } });

    const counts = await Promise.all([reconcileExpiredTimersOnce(), reconcileExpiredTimersOnce()]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);

    const row = await prisma.timeEntry.findUniqueOrThrow({ where: { id: body.id }, include: { segments: true } });
    expect(row.endedAt?.toISOString()).toBe(provenAt.toISOString());
    expect(row.segments[0]?.endedAt?.toISOString()).toBe(provenAt.toISOString());
    expect(row.closeReason).toBe('LEASE_EXPIRED');
    expect(row.serverFinalizedAt).toBeInstanceOf(Date);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).agentActiveEntryId).toBeNull();
  });

  it('does not clear a newer active-entry pointer while finalizing an expired timer', async () => {
    const user = await seedUser();
    const body = v2Body(new Date(Date.now() - 10 * 60_000));
    await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    await prisma.timeEntry.update({
      where: { id: body.id },
      data: {
        lastProvenAt: new Date(Date.now() - 4 * 60_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    await prisma.user.update({ where: { id: user.userId }, data: { agentActiveEntryId: 'newer-entry' } });

    expect(await reconcileExpiredTimersOnce()).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).agentActiveEntryId).toBe('newer-entry');
  });

  it('finalizes an expired entry at its proven boundary even if its segment is missing', async () => {
    const user = await seedUser();
    const provenAt = new Date(Date.now() - 4 * 60_000);
    const body = v2Body(new Date(Date.now() - 10 * 60_000));
    await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    await prisma.timeSegment.deleteMany({ where: { timeEntryId: body.id } });
    await prisma.timeEntry.update({
      where: { id: body.id },
      data: { lastProvenAt: provenAt, leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await prisma.user.update({ where: { id: user.userId }, data: { agentActiveEntryId: body.id } });

    expect(await reconcileExpiredTimersOnce()).toBe(1);
    await expect(prisma.timeEntry.findUniqueOrThrow({ where: { id: body.id } })).resolves.toMatchObject({
      endedAt: provenAt,
      closeReason: 'LEASE_EXPIRED',
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).agentActiveEntryId).toBeNull();
  });

  it('closes every open segment if an inconsistent expired entry contains more than one', async () => {
    const user = await seedUser();
    const provenAt = new Date(Date.now() - 4 * 60_000);
    const body = v2Body(new Date(Date.now() - 10 * 60_000));
    await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    await prisma.timeSegment.create({
      data: {
        id: fakeUlid('extra-open-segment'),
        timeEntryId: body.id,
        kind: 'WORK',
        startedAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    await prisma.timeEntry.update({
      where: { id: body.id },
      data: { lastProvenAt: provenAt, leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await reconcileExpiredTimersOnce()).toBe(1);
    expect(await prisma.timeSegment.count({ where: { timeEntryId: body.id, endedAt: null } })).toBe(0);
  });

  it('does not expire a future lease when the database session timezone is non-UTC', async () => {
    const [{ timezone }] = await prisma.$queryRaw<Array<{ timezone: string }>>`SHOW TIMEZONE`;
    expect(timezone).not.toBe('UTC');

    const user = await seedUser();
    const now = new Date();
    const body = v2Body(new Date(now.getTime() - 60_000));
    await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    const provenAt = new Date(now.getTime() - 1_000);
    const leaseExpiresAt = new Date(now.getTime() + 2 * 60_000);
    await prisma.timeEntry.update({ where: { id: body.id }, data: { lastProvenAt: provenAt, leaseExpiresAt } });

    expect(await reconcileExpiredTimersOnce(now)).toBe(0);
    const row = await prisma.timeEntry.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.endedAt).toBeNull();
    expect(row.leaseExpiresAt?.toISOString()).toBe(leaseExpiresAt.toISOString());
  });

  it('allows the same offline entry to reconcile after timeout, but ignores an older revision', async () => {
    const user = await seedUser();
    const body = v2Body(new Date(Date.now() - 12 * 60_000), 2);
    await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    await prisma.timeEntry.update({
      where: { id: body.id },
      data: {
        lastProvenAt: new Date(Date.now() - 5 * 60_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    await reconcileExpiredTimersOnce();

    const retriedCreate = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);
    expect(retriedCreate.status).toBe(200);
    expect(retriedCreate.body).toMatchObject({ disposition: 'FINALIZED', correction: 'LEASE_FINALIZED' });

    const sameRevision = await request(app).put(`/v1/time-entries/${body.id}/sync`).set(bearer(user.accessToken)).send({
      trackingProtocolVersion: 2,
      revision: 2,
      observedAt: new Date().toISOString(),
      endedAt: null,
      closeReason: null,
      segments: body.segments,
    });
    expect(sameRevision.status).toBe(200);
    expect(sameRevision.body).toMatchObject({ disposition: 'FINALIZED', correction: 'LEASE_FINALIZED' });
    expect(sameRevision.body.canonicalEntry.endedAt).not.toBeNull();
    expect(sameRevision.body.canonicalEntry.closeReason).toBe('LEASE_EXPIRED');

    const reopened = await request(app).put(`/v1/time-entries/${body.id}/sync`).set(bearer(user.accessToken)).send({
      trackingProtocolVersion: 2,
      revision: 3,
      observedAt: new Date().toISOString(),
      endedAt: null,
      closeReason: null,
      segments: body.segments,
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ disposition: 'APPLIED', acceptedRevision: 3 });
    expect(reopened.body.canonicalEntry.endedAt).toBeNull();
    expect(reopened.body.canonicalEntry.closeReason).toBeNull();
    expect(new Date(reopened.body.canonicalEntry.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now() + TIMER_LEASE_MS - 10_000);

    const stale = await request(app).put(`/v1/time-entries/${body.id}/sync`).set(bearer(user.accessToken)).send({
      trackingProtocolVersion: 2,
      revision: 2,
      observedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      closeReason: 'AGENT',
      segments: [{ ...body.segments[0], endedAt: new Date().toISOString() }],
    });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ disposition: 'STALE', acceptedRevision: 3 });
    expect(stale.body.canonicalEntry.endedAt).toBeNull();
  });

  it('atomically supersedes expired ownership and blocks a second live timer', async () => {
    const user = await seedUser();
    const first = v2Body(new Date(Date.now() - 8 * 60_000));
    expect((await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(first)).status).toBe(201);
    await prisma.timeEntry.update({
      where: { id: first.id },
      data: {
        lastProvenAt: new Date(Date.now() - 4 * 60_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    const second = v2Body(new Date());
    expect((await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(second)).status).toBe(201);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: first.id } })).closeReason).toBe('SUPERSEDED');

    const secondHeartbeat = await request(app).post('/v1/agent/heartbeat').set(bearer(user.accessToken)).send({
      agentVersion: '0.0.2-beta.26',
      platform: 'darwin',
      state: 'RUNNING',
      trackingProtocolVersion: 2,
      timerCheckpoint: {
        entryId: second.id,
        revision: 1,
        state: 'RUNNING',
        observedAt: new Date().toISOString(),
      },
    });
    expect(secondHeartbeat.body.timer.disposition).toBe('accepted');

    const rejectedOldHeartbeat = await request(app).post('/v1/agent/heartbeat').set(bearer(user.accessToken)).send({
      agentVersion: '0.0.2-beta.26',
      platform: 'darwin',
      state: 'RUNNING',
      trackingProtocolVersion: 2,
      timerCheckpoint: {
        entryId: first.id,
        revision: 1,
        state: 'RUNNING',
        observedAt: new Date().toISOString(),
      },
    });
    expect(rejectedOldHeartbeat.body.timer.disposition).toBe('finalized');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).agentActiveEntryId).toBe(second.id);

    const rejectedOldSync = await request(app).put(`/v1/time-entries/${first.id}/sync`).set(bearer(user.accessToken)).send({
      trackingProtocolVersion: 2,
      revision: 2,
      observedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      closeReason: 'AGENT',
      segments: [{ ...first.segments[0], endedAt: new Date().toISOString() }],
    });
    expect(rejectedOldSync.status).toBe(200);
    expect(rejectedOldSync.body).toMatchObject({ disposition: 'FINALIZED', correction: 'SUPERSEDED' });

    const conflict = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(v2Body(new Date()));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: 'active_timer_conflict', activeEntryId: second.id });
  });

  it('keeps legacy heartbeats compatible and outside the lease protocol', async () => {
    const user = await seedUser();
    const response = await request(app).post('/v1/agent/heartbeat').set(bearer(user.accessToken)).send({
      agentVersion: '0.0.2-beta.25',
      platform: 'win32',
    });
    expect(response.status).toBe(200);
    expect(response.body.timer).toBeNull();
  });

  it('rejects protocol-v2 lifecycle metadata on manual entries', async () => {
    const user = await seedUser();
    const body = { ...v2Body(new Date()), source: 'MANUAL' };
    const response = await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('timer_lifecycle_requires_auto_entry');
  });

  it('does not resurrect a closed legacy entry from a delayed heartbeat', async () => {
    const user = await seedUser();
    const startedAt = new Date(Date.now() - 5 * 60_000);
    const endedAt = new Date(Date.now() - 60_000);
    const entryId = fakeUlid('closed-legacy');
    await prisma.timeEntry.create({
      data: {
        id: entryId,
        clientUuid: fakeUlid('closed-legacy-client'),
        userId: user.userId,
        source: 'AUTO',
        startedAt,
        endedAt,
        segments: {
          create: {
            id: fakeUlid('closed-legacy-segment'),
            kind: 'WORK',
            startedAt,
            endedAt,
          },
        },
      },
    });

    const response = await request(app).post('/v1/agent/heartbeat').set(bearer(user.accessToken)).send({
      agentVersion: '0.0.2-beta.25',
      platform: 'darwin',
      state: 'RUNNING',
      activeEntryId: entryId,
    });

    expect(response.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).agentActiveEntryId).toBeNull();
  });

  it('allows only one winner when two fresh starts race with no existing row', async () => {
    const user = await seedUser();
    const results = await Promise.all([
      request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(v2Body(new Date())),
      request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(v2Body(new Date())),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await prisma.timeEntry.count({
      where: { userId: user.userId, trackingProtocolVersion: 2, endedAt: null },
    })).toBe(1);
  });

  it('returns the same entry when identical start retries race', async () => {
    const user = await seedUser();
    const body = v2Body(new Date());
    const results = await Promise.all([
      request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body),
      request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(new Set(results.map((result) => result.body.canonicalEntry.id))).toEqual(new Set([body.id]));
    expect(await prisma.timeEntry.count({ where: { clientUuid: body.clientUuid } })).toBe(1);
  });

  it('rejects the same revision when its normalized payload differs', async () => {
    const user = await seedUser();
    const body = v2Body(new Date(Date.now() - 60_000));
    expect((await request(app).post('/v1/time-entries').set(bearer(user.accessToken)).send(body)).status).toBe(201);

    const response = await request(app)
      .put(`/v1/time-entries/${body.id}/sync`)
      .set(bearer(user.accessToken))
      .send({
        trackingProtocolVersion: 2,
        revision: 1,
        observedAt: new Date().toISOString(),
        endedAt: null,
        closeReason: null,
        segments: [{ ...body.segments[0], id: fakeUlid('different-segment') }],
      });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'revision_payload_conflict', revision: 1 });
  });
});
