import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';
import { ulid } from 'ulid';

/**
 * Integration tests for the M14 appUsage payload on /v1/insights/day.
 *
 * Pure unit tests for the roll-up live in src/insights/appUsage.test.ts.
 * Here we exercise the full pipeline: per-minute samples land in
 * Postgres with active_app/_bundle, the route reads them, the
 * aggregator runs, the response carries `appUsage.topApps`.
 */

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function seedSamples(
  userId: string,
  rows: Array<{
    bucketStart: Date;
    keystrokes?: number;
    clicks?: number;
    activeApp: string | null;
    activeAppBundle: string | null;
    activeUrl?: string | null;
  }>,
) {
  for (const r of rows) {
    await prisma.activitySample.create({
      data: {
        id: ulid(),
        userId,
        bucketStart: r.bucketStart,
        keystrokes: r.keystrokes ?? 0,
        clicks: r.clicks ?? 0,
        mouseDistancePx: 0,
        scrollEvents: 0,
        activeApp: r.activeApp,
        activeAppBundle: r.activeAppBundle,
        activeUrl: r.activeUrl ?? null,
      },
    });
  }
}

describe('GET /v1/insights/day — appUsage', () => {
  it('returns an empty appUsage payload when no samples carry an app', async () => {
    const u = await seedUser();
    const res = await request(app).get('/v1/insights/day?date=2026-05-21&tz=UTC').set(auth(u.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.appUsage).toEqual({ totalMinutes: 0, topApps: [] });
  });

  it('rolls up minute counts per (app, bundle) and sorts desc', async () => {
    const u = await seedUser();
    const dayStart = new Date('2026-05-22T00:00:00.000Z').getTime();
    await seedSamples(u.userId, [
      // 3 minutes of Chrome
      { bucketStart: new Date(dayStart + 0), activeApp: 'Chrome', activeAppBundle: 'com.google.Chrome', keystrokes: 4 },
      { bucketStart: new Date(dayStart + 60_000), activeApp: 'Chrome', activeAppBundle: 'com.google.Chrome' },
      { bucketStart: new Date(dayStart + 120_000), activeApp: 'Chrome', activeAppBundle: 'com.google.Chrome' },
      // 2 minutes of VS Code
      { bucketStart: new Date(dayStart + 180_000), activeApp: 'VS Code', activeAppBundle: 'com.microsoft.VSCode', keystrokes: 30 },
      { bucketStart: new Date(dayStart + 240_000), activeApp: 'VS Code', activeAppBundle: 'com.microsoft.VSCode' },
      // 1 minute of Slack
      { bucketStart: new Date(dayStart + 300_000), activeApp: 'Slack', activeAppBundle: 'com.slack' },
      // 1 minute with null (policy-scrubbed — should be ignored in topApps but not totalMinutes)
      { bucketStart: new Date(dayStart + 360_000), activeApp: null, activeAppBundle: null, keystrokes: 12 },
    ]);

    const res = await request(app).get('/v1/insights/day?date=2026-05-22&tz=UTC').set(auth(u.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.appUsage.totalMinutes).toBe(6); // 3+2+1, null skipped
    const apps = res.body.appUsage.topApps as Array<{ app: string; minutes: number }>;
    expect(apps.map((a) => a.app)).toEqual(['Chrome', 'VS Code', 'Slack']);
    expect(apps[0]).toMatchObject({ app: 'Chrome', minutes: 3 });
    expect(apps[1]).toMatchObject({ app: 'VS Code', minutes: 2 });
  });

  it('strips active fields when the workspace policy is OFF (default)', async () => {
    const u = await seedUser();
    // Upload via the activity-samples endpoint so the policy scrub runs.
    const bucket = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const post = await request(app)
      .post('/v1/activity-samples')
      .set(auth(u.accessToken))
      .send({
        samples: [
          {
            id: ulid(),
            bucketStart: bucket,
            keystrokes: 1,
            clicks: 0,
            mouseDistancePx: 0,
            scrollEvents: 0,
            activeApp: 'Chrome',
            activeAppBundle: 'com.google.Chrome',
            activeTitle: 'secret tab',
            activeUrl: 'https://example.com/secret',
          },
        ],
      });
    expect(post.status).toBe(201);

    const res = await request(app).get(`/v1/insights/day?date=${today}&tz=UTC`).set(auth(u.accessToken));
    expect(res.status).toBe(200);
    // Default policy = captureApps off → server scrubbed activeApp before
    // the row was written, so the roll-up sees nothing.
    expect(res.body.appUsage.totalMinutes).toBe(0);
    expect(res.body.appUsage.topApps).toHaveLength(0);
  });

  it('surfaces apps when an ADMIN flips captureApps on first', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    // Flip workspace policy.
    await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(auth(admin.accessToken))
      .send({ captureApps: true });

    // The admin themselves uploads a sample. (Same-workspace constraint
    // — we don't need a separate user here.)
    const bucket = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    await request(app)
      .post('/v1/activity-samples')
      .set(auth(admin.accessToken))
      .send({
        samples: [
          {
            id: ulid(),
            bucketStart: bucket,
            keystrokes: 5,
            clicks: 1,
            mouseDistancePx: 0,
            scrollEvents: 0,
            activeApp: 'Chrome',
            activeAppBundle: 'com.google.Chrome',
            activeTitle: 'secret tab',
            activeUrl: 'https://example.com/secret',
          },
        ],
      });

    const res = await request(app).get(`/v1/insights/day?date=${today}&tz=UTC`).set(auth(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.appUsage.totalMinutes).toBe(1);
    expect(res.body.appUsage.topApps[0]).toMatchObject({ app: 'Chrome', appBundle: 'com.google.Chrome' });
    // Title + URL still scrubbed because captureTitles + captureUrls
    // weren't flipped — the row's columns are null. Only appUsage's
    // app+bundle survive.
  });

  it('rolls browser activity up by domain when URL capture is enabled', async () => {
    const admin = await seedUser({ role: 'ADMIN' });
    await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(auth(admin.accessToken))
      .send({ captureApps: true, captureUrls: true });

    const bucket = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const post = await request(app)
      .post('/v1/activity-samples')
      .set(auth(admin.accessToken))
      .send({
        samples: [
          {
            id: ulid(),
            bucketStart: bucket,
            keystrokes: 5,
            clicks: 1,
            mouseDistancePx: 0,
            scrollEvents: 0,
            activeApp: 'Google Chrome',
            activeAppBundle: 'com.google.Chrome',
            activeUrl: 'https://www.github.com/org/repo',
          },
        ],
      });
    expect(post.status).toBe(201);

    const res = await request(app).get(`/v1/insights/day?date=${today}&tz=UTC`).set(auth(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.appUsage.totalMinutes).toBe(1);
    expect(res.body.appUsage.topApps[0]).toMatchObject({
      app: 'github.com',
      appBundle: null,
      domain: 'github.com',
      sourceApp: 'Google Chrome',
      sourceAppBundle: 'com.google.Chrome',
      iconUrl: 'https://www.google.com/s2/favicons?domain=github.com&sz=64',
    });
  });
});
