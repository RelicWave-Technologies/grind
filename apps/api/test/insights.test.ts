import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { seedUser, fakeUlid, iso } from './helpers';

let app: Express;
beforeAll(() => {
  app = buildApp();
});

const DAY = '2026-05-20';
const DAY_T0 = new Date(`${DAY}T00:00:00.000Z`).getTime();
const MIN = 60_000;

async function seedSamples(
  userId: string,
  rows: Array<Partial<{ keystrokes: number; clicks: number; scrollEvents: number; mouseDistancePx: number; ikiCv: number; moveSpeedCv: number; pathStraightness: number }>>,
) {
  await prisma.activitySample.createMany({
    data: rows.map((r, i) => ({
      id: fakeUlid('as'),
      userId,
      bucketStart: new Date(DAY_T0 + i * MIN),
      keystrokes: r.keystrokes ?? 0,
      clicks: r.clicks ?? 0,
      scrollEvents: r.scrollEvents ?? 0,
      mouseDistancePx: r.mouseDistancePx ?? 0,
      ikiCv: r.ikiCv ?? null,
      moveSpeedCv: r.moveSpeedCv ?? null,
      pathStraightness: r.pathStraightness ?? null,
    })),
  });
}

describe('GET /v1/insights/score', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/v1/insights/score');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid day', async () => {
    const { accessToken } = await seedUser();
    const res = await request(app)
      .get('/v1/insights/score?day=not-a-date')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('returns a zeroed score for a day with no samples', async () => {
    const { accessToken } = await seedUser();
    const res = await request(app)
      .get(`/v1/insights/score?day=${DAY}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.score).toMatchObject({ score: 0, trackedMinutes: 0 });
    expect(res.body.anticheat).toMatchObject({ hardReject: false, riskScore: 0, flags: [] });
  });

  it('scores a busy day high and raises no anti-cheat flags', async () => {
    const { userId, accessToken } = await seedUser();
    const busy = { keystrokes: 180, clicks: 30, scrollEvents: 15, mouseDistancePx: 4000, ikiCv: 0.6, moveSpeedCv: 0.5, pathStraightness: 0.4 };
    await seedSamples(userId, Array.from({ length: 30 }, () => busy));
    const res = await request(app)
      .get(`/v1/insights/score?day=${DAY}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.score.trackedMinutes).toBe(30);
    expect(res.body.score.score).toBeGreaterThan(40);
    expect(res.body.anticheat.flags).toHaveLength(0);
  });

  it('uses the user activity role preset when scoring', async () => {
    const { userId, accessToken } = await seedUser();
    await seedSamples(userId, Array.from({ length: 5 }, () => ({ mouseDistancePx: 12000 })));

    await prisma.user.update({ where: { id: userId }, data: { activityRoleTitle: 'DESIGNER' } });
    const designer = await request(app)
      .get(`/v1/insights/score?day=${DAY}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(designer.status).toBe(200);
    expect(designer.body.role).toBe('DESIGNER');

    await prisma.user.update({ where: { id: userId }, data: { activityRoleTitle: 'DEVELOPER' } });
    const developer = await request(app)
      .get(`/v1/insights/score?day=${DAY}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(developer.status).toBe(200);
    expect(developer.body.role).toBe('DEVELOPER');
    expect(designer.body.score.score).toBeGreaterThan(developer.body.score.score);
  });

  it('scores quiet meeting samples as protected time', async () => {
    const { userId, accessToken } = await seedUser();
    await prisma.timeEntry.create({
      data: {
        id: fakeUlid('te'),
        clientUuid: fakeUlid('cu'),
        userId,
        source: 'AUTO',
        startedAt: new Date(`${DAY}T00:00:00Z`),
        endedAt: new Date(`${DAY}T00:01:00Z`),
        segments: {
          create: [
            {
              id: fakeUlid('seg'),
              kind: 'MEETING',
              startedAt: new Date(`${DAY}T00:00:00Z`),
              endedAt: new Date(`${DAY}T00:01:00Z`),
            },
          ],
        },
      },
    });
    await seedSamples(userId, [{ keystrokes: 0, clicks: 0, scrollEvents: 0, mouseDistancePx: 0 }]);
    const res = await request(app)
      .get(`/v1/insights/score?day=${DAY}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.score.trackedMinutes).toBe(1);
    expect(res.body.score.protectedMinutes).toBe(1);
    expect(res.body.score.score).toBe(100);
  });

  it('excludes invalidated samples from score totals', async () => {
    const { workspaceId, userId, accessToken } = await seedUser();
    await seedSamples(userId, [{ keystrokes: 200 }]);
    const flag = await prisma.activityFlag.create({
      data: {
        userId,
        type: 'METRONOMIC',
        windowStart: new Date(`${DAY}T00:00:00Z`),
        windowEnd: new Date(`${DAY}T00:01:00Z`),
        riskScore: 60,
        evidence: {},
        status: 'RESOLVED',
        resolution: 'TIME_INVALIDATED',
        resolvedAt: new Date(`${DAY}T00:02:00Z`),
        resolvedNote: 'Invalidated',
      },
    });
    await prisma.timeInvalidation.create({
      data: {
        workspaceId,
        flagId: flag.id,
        userId,
        windowStart: flag.windowStart,
        windowEnd: flag.windowEnd,
        reason: 'Invalidated',
      },
    });

    const res = await request(app)
      .get(`/v1/insights/score?day=${DAY}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.score.trackedMinutes).toBe(0);
    expect(res.body.totals.keystrokes).toBe(0);
  });

  it('detects a key-spam bot day: hard reject + flags', async () => {
    const { userId, accessToken } = await seedUser();
    await seedSamples(userId, Array.from({ length: 8 }, () => ({ keystrokes: 1500, ikiCv: 0.01 })));
    const res = await request(app)
      .get(`/v1/insights/score?day=${DAY}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.anticheat.hardReject).toBe(true);
    const types = res.body.anticheat.flags.map((f: { type: string }) => f.type);
    expect(types).toContain('IMPOSSIBLE_RATE');
    expect(types).toContain('METRONOMIC');
  });

  it('scopes to the requesting user only', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await seedSamples(a.userId, Array.from({ length: 10 }, () => ({ keystrokes: 150, clicks: 20, mouseDistancePx: 3000 })));
    // b has no samples that day → zero
    const res = await request(app)
      .get(`/v1/insights/score?day=${DAY}`)
      .set('Authorization', `Bearer ${b.accessToken}`);
    expect(res.body.score.trackedMinutes).toBe(0);
  });
});
