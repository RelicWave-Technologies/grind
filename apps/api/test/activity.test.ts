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

  it('a later partial of the same minute never overwrites what the minute already had', async () => {
    const u = await seedUser();
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${u.accessToken}`);
    // The agent sealed the head of the minute on quit, then restarted within
    // it and sent the tail under a new id.
    await auth(request(app).post('/v1/activity-samples')).send({
      samples: [sample({ bucketStart: iso(T0), keystrokes: 40, clicks: 5, ikiCv: 0.5 })],
    });
    await auth(request(app).post('/v1/activity-samples')).send({
      samples: [sample({ bucketStart: iso(T0), keystrokes: 3, clicks: 0, ikiCv: 0.9 })],
    });
    // The agent's merged total for the minute, re-sent.
    await auth(request(app).post('/v1/activity-samples')).send({
      samples: [sample({ bucketStart: iso(T0), keystrokes: 43, clicks: 5, ikiCv: 0.55 })],
    });

    const rows = await prisma.activitySample.findMany({ where: { userId: u.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ keystrokes: 43, clicks: 5 });
    expect(rows[0]!.ikiCv).toBeCloseTo(0.55, 5);
  });

  it('merges the same minute sent twice in one batch', async () => {
    const u = await seedUser();
    const res = await request(app)
      .post('/v1/activity-samples')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({
        samples: [
          sample({ bucketStart: iso(T0), keystrokes: 7, clicks: 0 }),
          sample({ bucketStart: iso(T0), keystrokes: 2, clicks: 4 }),
          sample({ bucketStart: iso(T0 + MIN), keystrokes: 0, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 }),
        ],
      });
    expect(res.status).toBe(201);
    const rows = await prisma.activitySample.findMany({ where: { userId: u.userId }, orderBy: { bucketStart: 'asc' } });
    expect(rows.map((r) => [r.bucketStart.getTime(), r.keystrokes, r.clicks])).toEqual([
      [T0, 7, 4],
      [T0 + MIN, 0, 0], // a quiet tracked minute is kept
    ]);
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
    const missingId = fakeUlid('missing');

    const res = await request(app)
      .post('/v1/activity-samples')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({
        samples: [
          sample({ bucketStart: iso(T0), timeEntryId: ownEntry.id }),
          sample({ bucketStart: iso(T0 + MIN), timeEntryId: missingId }),
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
    // Only the entry the server does not have yet is remembered, to be linked
    // later; another user's entry is never claimed.
    expect(rows.map((row) => row.claimedTimeEntryId)).toEqual([null, missingId, null]);
  });

  it('links minutes that arrived before their entry once the entry is created', async () => {
    // A stuck sync queue: the agent uploads the minutes, the entry create
    // arrives much later.
    const u = await seedUser();
    const other = await seedUser();
    const entryId = fakeUlid('late-entry');
    const post = (token: string, samples: unknown[]) =>
      request(app).post('/v1/activity-samples').set('Authorization', `Bearer ${token}`).send({ samples });
    expect((await post(u.accessToken, [
      sample({ bucketStart: iso(T0), timeEntryId: entryId }),
      sample({ bucketStart: iso(T0 + MIN), timeEntryId: entryId }),
    ])).body).toMatchObject({ accepted: 2, detached: 2 });
    // Somebody else naming the same id never gets attached to it.
    await post(other.accessToken, [sample({ bucketStart: iso(T0), timeEntryId: entryId })]);

    const created = await request(app)
      .post('/v1/time-entries')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({
        id: entryId,
        clientUuid: fakeUlid('late-client'),
        source: 'AUTO',
        startedAt: iso(T0),
        endedAt: iso(T0 + 5 * MIN),
        segments: [{ id: fakeUlid('late-seg'), kind: 'WORK', startedAt: iso(T0), endedAt: iso(T0 + 5 * MIN) }],
      });
    expect(created.status).toBe(201);

    const mine = await prisma.activitySample.findMany({ where: { userId: u.userId }, orderBy: { bucketStart: 'asc' } });
    expect(mine.map((row) => [row.timeEntryId, row.claimedTimeEntryId])).toEqual([[entryId, null], [entryId, null]]);
    const theirs = await prisma.activitySample.findFirstOrThrow({ where: { userId: other.userId } });
    expect([theirs.timeEntryId, theirs.claimedTimeEntryId]).toEqual([null, entryId]);

    // A minute re-sent with the entry now known stays attached, claim cleared.
    await post(u.accessToken, [sample({ bucketStart: iso(T0 + 2 * MIN), timeEntryId: entryId })]);
    const third = await prisma.activitySample.findFirstOrThrow({
      where: { userId: u.userId, bucketStart: new Date(T0 + 2 * MIN) },
    });
    expect([third.timeEntryId, third.claimedTimeEntryId]).toEqual([entryId, null]);
  });

  it('never drops an attached minute back to a claim when it is re-sent', async () => {
    const u = await seedUser();
    const entry = await prisma.timeEntry.create({
      data: { id: fakeUlid('entry'), clientUuid: fakeUlid('client'), userId: u.userId, source: 'AUTO', startedAt: new Date(T0) },
    });
    const post = (samples: unknown[]) =>
      request(app).post('/v1/activity-samples').set('Authorization', `Bearer ${u.accessToken}`).send({ samples });
    await post([sample({ bucketStart: iso(T0), timeEntryId: entry.id })]);
    await post([sample({ bucketStart: iso(T0), keystrokes: 1, timeEntryId: fakeUlid('unknown') })]);

    const row = await prisma.activitySample.findFirstOrThrow({ where: { userId: u.userId } });
    expect([row.timeEntryId, row.claimedTimeEntryId]).toEqual([entry.id, null]);
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

describe('a window title cut through an emoji', () => {
  /**
   * The production 500: an agent caps `activeTitle` at 300 UTF-16 code units,
   * the cut lands inside U+1F600, and the orphaned high surrogate cannot be
   * encoded as UTF-8. Postgres rejected the statement with "unexpected end of
   * hex escape" and the whole batch was lost — 68,782 times.
   */
  const brokenTitle = `${'a'.repeat(299)}\u{1F600}tail`.slice(0, 300);

  /** Titles are policy-gated server-side; this report needs them on. */
  async function seedUserWithTitles() {
    const u = await seedUser();
    await prisma.workspacePolicy.create({
      data: { workspaceId: u.workspaceId, captureApps: true, captureTitles: true },
    });
    return u;
  }

  it('is not a 500, and does not take the rest of the batch with it', async () => {
    const u = await seedUserWithTitles();
    // Confirm the fixture really is the broken shape before relying on it.
    const last = brokenTitle.charCodeAt(brokenTitle.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(true);

    const res = await request(app)
      .post('/v1/activity-samples')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({
        samples: [
          sample({ bucketStart: iso(T0), activeApp: 'Chrome', activeTitle: brokenTitle }),
          sample({ bucketStart: iso(T0 + MIN), activeApp: 'Slack', keystrokes: 11 }),
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(2);

    const rows = await prisma.activitySample.findMany({
      where: { userId: u.userId },
      orderBy: { bucketStart: 'asc' },
    });
    expect(rows).toHaveLength(2);
    // The half character is gone; what was stored round-trips through UTF-8.
    const stored = rows[0]!.activeTitle!;
    expect(stored).toBe('a'.repeat(299));
    expect(Buffer.from(stored, 'utf8').toString('utf8')).toBe(stored);
    // The innocent second sample survived.
    expect(rows[1]).toMatchObject({ keystrokes: 11 });
  });

  it('cuts metadata from older agents to the caps instead of refusing the batch', async () => {
    // Agents up to beta.26 cap every field at 1,024 chars. One long Windows
    // app path used to 400 the batch, and the agent re-sent it forever.
    const u = await seedUserWithTitles();
    const res = await request(app)
      .post('/v1/activity-samples')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({
        samples: [
          sample({ bucketStart: iso(T0), activeApp: 'A'.repeat(1_024), activeAppBundle: 'B'.repeat(1_024), activeTitle: 'T'.repeat(1_024), activeUrl: 'https://x.example/'.padEnd(3_000, 'u') }),
          sample({ bucketStart: iso(T0 + MIN), keystrokes: 11 }),
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.accepted).toBe(2);
    const [first, second] = await prisma.activitySample.findMany({ where: { userId: u.userId }, orderBy: { bucketStart: 'asc' } });
    expect(first).toMatchObject({ activeApp: 'A'.repeat(120), activeAppBundle: 'B'.repeat(200), activeTitle: 'T'.repeat(300) });
    expect(second).toMatchObject({ keystrokes: 11 });
  });

  it('still refuses absurdly long metadata', async () => {
    const u = await seedUser();
    const res = await request(app)
      .post('/v1/activity-samples')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ samples: [sample({ activeApp: 'A'.repeat(5_000) })] });
    expect(res.status).toBe(400);
  });

  it('keeps an emoji that arrived whole', async () => {
    const u = await seedUserWithTitles();
    const res = await request(app)
      .post('/v1/activity-samples')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ samples: [sample({ bucketStart: iso(T0), activeApp: 'Slack', activeTitle: 'general \u{1F600}' })] });
    expect(res.status).toBe(201);
    const row = await prisma.activitySample.findFirst({ where: { userId: u.userId } });
    expect(row!.activeTitle).toBe('general \u{1F600}');
  });
});
