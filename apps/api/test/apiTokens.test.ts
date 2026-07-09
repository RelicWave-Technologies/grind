import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { fakeUlid, seedUser } from './helpers';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const ALL_READ_SCOPES = ['read:people', 'read:device-health', 'read:time-summary', 'read:manual-time'];

async function createToken(accessToken: string, scopes: string[] = ['read:people']) {
  const res = await request(app)
    .post('/v1/admin/api-tokens')
    .set(bearer(accessToken))
    .send({ name: 'Local MCP', scopes });
  expect(res.status).toBe(201);
  return res.body as { token: string; apiToken: { id: string; tokenPrefix: string } };
}

describe('admin API tokens', () => {
  it('lets admins create and list tokens, but returns the raw secret only once', async () => {
    const admin = await seedUser({ role: 'ADMIN' });

    const created = await createToken(admin.accessToken, ['read:people', 'read:device-health']);
    expect(created.token).toMatch(/^timo_mcp_atk_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{32,}$/);
    expect(created.apiToken.tokenPrefix).toMatch(/^timo_mcp_atk_[A-Za-z0-9_-]{12}$/);

    const row = await prisma.apiToken.findUniqueOrThrow({ where: { id: created.apiToken.id } });
    expect(row.tokenHash).not.toContain(created.token);

    const list = await request(app)
      .get('/v1/admin/api-tokens')
      .set(bearer(admin.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.tokens).toHaveLength(1);
    expect(list.body.tokens[0].token).toBeUndefined();
    expect(list.body.tokens[0].tokenPrefix).toBe(created.apiToken.tokenPrefix);
  });

  it('blocks managers and members from creating tokens', async () => {
    const manager = await seedUser({ role: 'MANAGER' });
    const member = await seedUser({ role: 'MEMBER' });

    for (const user of [manager, member]) {
      const res = await request(app)
        .post('/v1/admin/api-tokens')
        .set(bearer(user.accessToken))
        .send({ name: 'Nope', scopes: ['read:people'] });
      expect(res.status).toBe(403);
    }
  });

  it('updates last-used and serves scoped MCP routes with a valid token', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    await prisma.user.update({
      where: { id: admin.userId },
      data: { agentVersion: '0.0.2-beta.25', agentPlatform: 'darwin', agentState: 'RUNNING' },
    });
    const created = await createToken(admin.accessToken, ['read:device-health']);

    const res = await request(app)
      .get('/v1/mcp/version-adoption')
      .set(bearer(created.token));

    expect(res.status).toBe(200);
    expect(res.body.totalUsers).toBe(1);
    expect(res.body.buckets).toEqual([
      { platform: 'darwin', version: '0.0.2-beta.25', state: 'RUNNING', count: 1 },
    ]);

    const row = await prisma.apiToken.findUniqueOrThrow({ where: { id: created.apiToken.id } });
    expect(row.lastUsedAt).toBeInstanceOf(Date);
  });

  it('rejects revoked tokens and tokens missing a required scope', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    const peopleOnly = await createToken(admin.accessToken, ['read:people']);

    const wrongScope = await request(app)
      .get('/v1/mcp/device-health')
      .set(bearer(peopleOnly.token));
    expect(wrongScope.status).toBe(403);

    await request(app)
      .post(`/v1/admin/api-tokens/${peopleOnly.apiToken.id}/revoke`)
      .set(bearer(admin.accessToken))
      .expect(200);

    const revoked = await request(app)
      .get('/v1/mcp/people')
      .set(bearer(peopleOnly.token));
    expect(revoked.status).toBe(401);
  });

  it('keeps MCP responses scoped to the token owner workspace', async () => {
    const first = await seedUser({ role: 'ADMIN' });
    const second = await seedUser({ role: 'ADMIN' });
    await prisma.user.update({ where: { id: first.userId }, data: { name: 'First Admin' } });
    await prisma.user.update({ where: { id: second.userId }, data: { name: 'Second Admin' } });
    const created = await createToken(first.accessToken, ['read:people', 'read:device-health']);

    const res = await request(app)
      .get('/v1/mcp/people')
      .set(bearer(created.token));

    expect(res.status).toBe(200);
    expect(res.body.users.map((user: { name: string }) => user.name)).toEqual(['First Admin']);
  });

  it('serves detailed read-only MCP routes with scoped tokens', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    const team = await prisma.team.create({
      data: { workspaceId: admin.workspaceId, name: 'Design' },
    });
    await prisma.teamManager.create({
      data: { workspaceId: admin.workspaceId, teamId: team.id, userId: admin.userId },
    });
    await prisma.user.update({
      where: { id: admin.userId },
      data: {
        teamId: team.id,
        agentVersion: '0.0.2-beta.25',
        agentPlatform: 'darwin',
        agentState: 'RUNNING',
        agentLastSeenAt: new Date(),
        agentScreenPermissionStatus: 'granted',
        agentAccessibilityTrusted: true,
        agentAccessibilityReady: true,
      },
    });

    const startedAt = new Date('2026-07-09T03:00:00.000Z');
    const endedAt = new Date('2026-07-09T04:00:00.000Z');
    await prisma.timeEntry.create({
      data: {
        id: fakeUlid('te'),
        clientUuid: fakeUlid('client'),
        userId: admin.userId,
        source: 'AUTO',
        startedAt,
        endedAt,
        segments: {
          create: {
            id: fakeUlid('seg'),
            kind: 'WORK',
            startedAt,
            endedAt,
          },
        },
      },
    });
    await prisma.manualTimeRequest.create({
      data: {
        clientUuid: fakeUlid('mtr-client'),
        userId: admin.userId,
        taskSummary: 'Design review',
        requestedStart: startedAt,
        requestedEnd: endedAt,
        reason: 'Forgot to start Timo',
        status: 'PENDING',
      },
    });
    await prisma.activityFlag.create({
      data: {
        userId: admin.userId,
        type: 'METRONOMIC',
        windowStart: startedAt,
        windowEnd: endedAt,
        riskScore: 30,
        evidence: { keysPerMin: 120 },
      },
    });
    const created = await createToken(admin.accessToken, ALL_READ_SCOPES);

    const overview = await request(app)
      .get('/v1/mcp/workspace-overview?tz=UTC')
      .set(bearer(created.token));
    expect(overview.status).toBe(200);
    expect(overview.body.devices.running).toBe(1);
    expect(overview.body.manualTime.pendingTotal).toBe(1);
    expect(overview.body.activityFlags.openTotal).toBe(1);

    const userDetail = await request(app)
      .get(`/v1/mcp/user-detail?userId=${admin.userId}&from=2026-07-09&to=2026-07-09&tz=UTC`)
      .set(bearer(created.token));
    expect(userDetail.status).toBe(200);
    expect(userDetail.body.user.device.status).toBe('running');
    expect(userDetail.body.time.total.workedMs).toBe(60 * 60 * 1000);
    expect(userDetail.body.manualTimeRequests).toHaveLength(1);

    const teamSummary = await request(app)
      .get(`/v1/mcp/team-summary?teamId=${team.id}&from=2026-07-09&to=2026-07-09&tz=UTC`)
      .set(bearer(created.token));
    expect(teamSummary.status).toBe(200);
    expect(teamSummary.body.teams[0].deviceCounts.running).toBe(1);
    expect(teamSummary.body.teams[0].time.total.workedMs).toBe(60 * 60 * 1000);

    const flags = await request(app)
      .get('/v1/mcp/activity-flags-summary?from=2026-07-09&to=2026-07-09&tz=UTC')
      .set(bearer(created.token));
    expect(flags.status).toBe(200);
    expect(flags.body.counts.byStatus).toEqual([{ status: 'OPEN', count: 1 }]);
    expect(flags.body.flags[0]).toMatchObject({ type: 'METRONOMIC', riskScore: 30 });
  });

  it('infers break and lunch-candidate time without counting before or after work', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    await prisma.user.update({
      where: { id: admin.userId },
      data: { name: 'Break Tester' },
    });
    await prisma.timeEntry.create({
      data: {
        id: fakeUlid('te'),
        clientUuid: fakeUlid('client'),
        userId: admin.userId,
        source: 'AUTO',
        startedAt: new Date('2026-07-08T09:00:00.000Z'),
        endedAt: new Date('2026-07-08T11:00:00.000Z'),
        segments: {
          create: {
            id: fakeUlid('seg'),
            kind: 'WORK',
            startedAt: new Date('2026-07-08T09:00:00.000Z'),
            endedAt: new Date('2026-07-08T11:00:00.000Z'),
          },
        },
      },
    });
    const manualEntry = await prisma.timeEntry.create({
      data: {
        id: fakeUlid('te'),
        clientUuid: fakeUlid('client'),
        userId: admin.userId,
        source: 'MANUAL',
        startedAt: new Date('2026-07-08T12:00:00.000Z'),
        endedAt: new Date('2026-07-08T13:00:00.000Z'),
        notes: 'Approved correction',
        segments: {
          create: {
            id: fakeUlid('seg'),
            kind: 'WORK',
            startedAt: new Date('2026-07-08T12:00:00.000Z'),
            endedAt: new Date('2026-07-08T13:00:00.000Z'),
          },
        },
      },
    });
    await prisma.manualTimeRequest.create({
      data: {
        clientUuid: fakeUlid('mtr-client'),
        userId: admin.userId,
        taskSummary: 'Customer escalation',
        requestedStart: new Date('2026-07-08T12:00:00.000Z'),
        requestedEnd: new Date('2026-07-08T13:00:00.000Z'),
        reason: 'Worked during lunch but forgot to start timer',
        status: 'APPROVED',
        approverId: admin.userId,
        decidedById: admin.userId,
        decidedAt: new Date('2026-07-08T14:00:00.000Z'),
        decidedReason: 'Calendar matched the escalation call',
        decisionSource: 'DASHBOARD',
        timeEntryId: manualEntry.id,
      },
    });
    await prisma.manualTimeRequest.create({
      data: {
        clientUuid: fakeUlid('mtr-client'),
        userId: admin.userId,
        taskSummary: 'Pending overlap',
        requestedStart: new Date('2026-07-08T13:05:00.000Z'),
        requestedEnd: new Date('2026-07-08T13:20:00.000Z'),
        reason: 'Asked to cover part of this gap',
        status: 'PENDING',
      },
    });
    await prisma.timeEntry.create({
      data: {
        id: fakeUlid('te'),
        clientUuid: fakeUlid('client'),
        userId: admin.userId,
        source: 'AUTO',
        startedAt: new Date('2026-07-08T13:30:00.000Z'),
        endedAt: new Date('2026-07-08T17:00:00.000Z'),
        segments: {
          create: {
            id: fakeUlid('seg'),
            kind: 'WORK',
            startedAt: new Date('2026-07-08T13:30:00.000Z'),
            endedAt: new Date('2026-07-08T17:00:00.000Z'),
          },
        },
      },
    });
    const created = await createToken(admin.accessToken, ['read:people', 'read:time-summary', 'read:manual-time']);

    const res = await request(app)
      .get('/v1/mcp/break-summary?from=2026-07-08&to=2026-07-08&tz=UTC&minBreakMinutes=5&lunchMinMinutes=30')
      .set(bearer(created.token));

    expect(res.status).toBe(200);
    expect(res.body.method.lunch).toContain('Candidate only');
    expect(res.body.totals.totalBreakMs).toBe(90 * 60 * 1000);
    expect(res.body.totals.lunchCandidateMs).toBe(60 * 60 * 1000);
    expect(res.body.totals.otherBreakMs).toBe(30 * 60 * 1000);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({
      name: 'Break Tester',
      totalBreakMs: 90 * 60 * 1000,
      lunchCandidateMs: 60 * 60 * 1000,
      otherBreakMs: 30 * 60 * 1000,
      breakCount: 2,
    });
    expect(res.body.users[0].days[0]).toMatchObject({
      firstTrackedAt: '2026-07-08T09:00:00.000Z',
      lastTrackedAt: '2026-07-08T17:00:00.000Z',
      breakCount: 2,
      totalBreakMs: 90 * 60 * 1000,
    });
    expect(res.body.users[0].days[0].breaks.map((item: { classification: string; durationMs: number }) => ({
      classification: item.classification,
      durationMs: item.durationMs,
    }))).toEqual([
      { classification: 'lunch_candidate', durationMs: 60 * 60 * 1000 },
      { classification: 'break', durationMs: 30 * 60 * 1000 },
    ]);
    expect(res.body.users[0].days[0].manualTimeBlocks).toHaveLength(1);
    expect(res.body.users[0].days[0].manualTimeBlocks[0].manualTimeRequest).toMatchObject({
      taskSummary: 'Customer escalation',
      reason: 'Worked during lunch but forgot to start timer',
      status: 'APPROVED',
      decidedReason: 'Calendar matched the escalation call',
      decisionSource: 'DASHBOARD',
    });
    expect(res.body.users[0].days[0].breaks[0].evidence.previousTrackedBlock.sources[0]).toMatchObject({
      source: 'AUTO',
      kind: 'WORK',
    });
    expect(res.body.users[0].days[0].breaks[0].evidence.nextTrackedBlock.sources[0].manualTimeRequest).toMatchObject({
      reason: 'Worked during lunch but forgot to start timer',
      decidedReason: 'Calendar matched the escalation call',
    });
    expect(res.body.users[0].days[0].breaks[1].evidence.manualRequestsOverlappingGap).toHaveLength(1);
    expect(res.body.users[0].days[0].breaks[1].evidence.manualRequestsOverlappingGap[0]).toMatchObject({
      status: 'PENDING',
      reason: 'Asked to cover part of this gap',
    });
  });

  it('keeps detailed MCP routes privacy-safe', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    await prisma.user.update({
      where: { id: admin.userId },
      data: {
        agentVersion: '0.0.2-beta.25',
        agentPlatform: 'win32',
        agentState: 'RUNNING',
        agentLastSeenAt: new Date(),
      },
    });
    const startedAt = new Date('2026-07-09T05:00:00.000Z');
    const endedAt = new Date('2026-07-09T05:10:00.000Z');
    const entry = await prisma.timeEntry.create({
      data: {
        id: fakeUlid('te'),
        clientUuid: fakeUlid('client'),
        userId: admin.userId,
        source: 'AUTO',
        startedAt,
        endedAt,
        segments: {
          create: {
            id: fakeUlid('seg'),
            kind: 'WORK',
            startedAt,
            endedAt,
          },
        },
      },
    });
    await prisma.activitySample.create({
      data: {
        id: fakeUlid('sample'),
        userId: admin.userId,
        timeEntryId: entry.id,
        bucketStart: startedAt,
        keystrokes: 99,
        clicks: 88,
        mouseDistancePx: 777,
        scrollEvents: 6,
        activeTitle: 'SECRET_WINDOW_TITLE',
        activeUrl: 'https://private.example/secret',
      },
    });
    await prisma.screenshot.create({
      data: {
        id: fakeUlid('shot'),
        userId: admin.userId,
        timeEntryId: entry.id,
        capturedAt: startedAt,
        s3Key: 'secret/screenshot.png',
        fullUrl: 'https://private.example/screenshot.png',
        thumbUrl: 'https://private.example/thumb.png',
      },
    });
    await prisma.activityFlag.create({
      data: {
        userId: admin.userId,
        type: 'IMPOSSIBLE_RATE',
        windowStart: startedAt,
        windowEnd: endedAt,
        riskScore: 90,
        evidence: { rawSignal: 'SECRET_EVIDENCE' },
      },
    });
    const created = await createToken(admin.accessToken, ALL_READ_SCOPES);

    const responses = await Promise.all([
      request(app).get('/v1/mcp/workspace-overview?tz=UTC').set(bearer(created.token)),
      request(app).get(`/v1/mcp/user-detail?userId=${admin.userId}&from=2026-07-09&to=2026-07-09&tz=UTC`).set(bearer(created.token)),
      request(app).get('/v1/mcp/time-summary?from=2026-07-09&to=2026-07-09&tz=UTC').set(bearer(created.token)),
      request(app).get('/v1/mcp/break-summary?from=2026-07-09&to=2026-07-09&tz=UTC').set(bearer(created.token)),
      request(app).get('/v1/mcp/activity-flags-summary?from=2026-07-09&to=2026-07-09&tz=UTC').set(bearer(created.token)),
    ]);

    for (const res of responses) expect(res.status).toBe(200);
    const payload = JSON.stringify(responses.map((res) => res.body));
    expect(payload).not.toContain('SECRET_WINDOW_TITLE');
    expect(payload).not.toContain('https://private.example');
    expect(payload).not.toContain('secret/screenshot.png');
    expect(payload).not.toContain('SECRET_EVIDENCE');
    expect(payload).not.toContain('activeTitle');
    expect(payload).not.toContain('activeUrl');
    expect(payload).not.toContain('fullUrl');
    expect(payload).not.toContain('thumbUrl');
    expect(payload).not.toContain('s3Key');
    expect(JSON.stringify(responses[4].body)).not.toContain('evidence');
  });

  it('rejects missing scopes and over-large detailed MCP ranges', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    const peopleOnly = await createToken(admin.accessToken, ['read:people']);

    const missingScope = await request(app)
      .get('/v1/mcp/activity-flags-summary')
      .set(bearer(peopleOnly.token));
    expect(missingScope.status).toBe(403);

    const missingBreakScope = await request(app)
      .get('/v1/mcp/break-summary')
      .set(bearer(peopleOnly.token));
    expect(missingBreakScope.status).toBe(403);

    const missingBreakManualScope = await createToken(admin.accessToken, ['read:people', 'read:time-summary']);
    const missingBreakManual = await request(app)
      .get('/v1/mcp/break-summary')
      .set(bearer(missingBreakManualScope.token));
    expect(missingBreakManual.status).toBe(403);

    const full = await createToken(admin.accessToken, ALL_READ_SCOPES);
    const tooLarge = await request(app)
      .get('/v1/mcp/activity-flags-summary?from=2026-01-01&to=2026-02-15&tz=UTC')
      .set(bearer(full.token));
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body).toMatchObject({ error: 'invalid_date_range', maxDays: 31 });
  });
});
