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

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function sample(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: fakeUlid('as'),
    bucketStart: iso(T0),
    keystrokes: 42,
    clicks: 7,
    mouseDistancePx: 1234,
    scrollEvents: 3,
    ikiCv: 0.62,
    moveSpeedCv: 0.41,
    pathStraightness: 0.33,
    ...over,
  };
}

describe('POST /v1/activity-samples', () => {
  it('401 without a token', async () => {
    const res = await request(app).post('/v1/activity-samples').send({ samples: [sample()] });
    expect(res.status).toBe(401);
  });

  it('accepts a batch and persists content-free counts + CVs', async () => {
    const u = await seedUser();
    const res = await request(app)
      .post('/v1/activity-samples')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ samples: [sample({ bucketStart: iso(T0) }), sample({ bucketStart: iso(T0 + MIN) })] });
    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(2);

    const rows = await prisma.activitySample.findMany({ where: { userId: u.userId }, orderBy: { bucketStart: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ keystrokes: 42, clicks: 7, scrollEvents: 3 });
    expect(rows[0]!.ikiCv).toBeCloseTo(0.62, 5);
  });

  it('is idempotent on (userId, bucketStart) — re-upload updates in place', async () => {
    const u = await seedUser();
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${u.accessToken}`);
    await auth(request(app).post('/v1/activity-samples')).send({ samples: [sample({ bucketStart: iso(T0), keystrokes: 10 })] });
    // same minute, corrected counts
    await auth(request(app).post('/v1/activity-samples')).send({ samples: [sample({ bucketStart: iso(T0), keystrokes: 99 })] });

    const rows = await prisma.activitySample.findMany({ where: { userId: u.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keystrokes).toBe(99);
  });

  it('keeps a mixed batch when a timer parent is missing or belongs to another user', async () => {
    const u = await seedUser();
    const outsider = await seedUser();
    const ownEntry = await prisma.timeEntry.create({
      data: {
        id: fakeUlid('entry'),
        clientUuid: fakeUlid('client'),
        userId: u.userId,
        source: 'AUTO',
        startedAt: new Date(T0),
      },
    });
    const foreignEntry = await prisma.timeEntry.create({
      data: {
        id: fakeUlid('entry'),
        clientUuid: fakeUlid('client'),
        userId: outsider.userId,
        source: 'AUTO',
        startedAt: new Date(T0),
      },
    });

    const res = await request(app)
      .post('/v1/activity-samples')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({
        samples: [
          sample({ bucketStart: iso(T0), timeEntryId: ownEntry.id }),
          sample({ bucketStart: iso(T0 + MIN), timeEntryId: fakeUlid('missing') }),
          sample({ bucketStart: iso(T0 + 2 * MIN), timeEntryId: foreignEntry.id }),
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ accepted: 3, detached: 2 });
    const rows = await prisma.activitySample.findMany({
      where: { userId: u.userId },
      orderBy: { bucketStart: 'asc' },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.timeEntryId)).toEqual([ownEntry.id, null, null]);
  });

  it('scopes samples to the caller', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    await request(app).post('/v1/activity-samples').set('Authorization', `Bearer ${u1.accessToken}`).send({ samples: [sample()] });
    await request(app).post('/v1/activity-samples').set('Authorization', `Bearer ${u2.accessToken}`).send({ samples: [sample({ bucketStart: iso(T0 + 5 * MIN) })] });
    expect(await prisma.activitySample.count({ where: { userId: u1.userId } })).toBe(1);
    expect(await prisma.activitySample.count({ where: { userId: u2.userId } })).toBe(1);
  });

  it('rejects malformed samples (negative counts)', async () => {
    const u = await seedUser();
    const res = await request(app)
      .post('/v1/activity-samples')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ samples: [sample({ keystrokes: -1 })] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });
});
