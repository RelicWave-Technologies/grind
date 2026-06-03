import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';
import { ulid } from 'ulid';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
async function seedWorkspace() {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-wp`;
  const ws = await prisma.workspace.create({ data: { name: `WS ${stamp}` } });
  const mk = (email: string, role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER') =>
    prisma.user.create({
      data: {
        workspaceId: ws.id,
        email: `${email}-${stamp}@test.local`,
        name: email,
        role,
        passwordHash: 'x'.repeat(60),
      },
    });
  const admin = await mk('admin', 'ADMIN');
  const member = await mk('member', 'MEMBER');
  const token = (u: { id: string; role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' }) =>
    signAccessToken({ sub: u.id, ws: ws.id, role: u.role });
  return {
    ws,
    admin: { id: admin.id, token: token(admin) },
    member: { id: member.id, token: token(member) },
  };
}

describe('GET /v1/admin/workspace-policy', () => {
  it('lazy-creates a row with privacy-first defaults', async () => {
    const { ws, member } = await seedWorkspace();
    const res = await request(app).get('/v1/admin/workspace-policy').set(bearer(member.token));
    expect(res.status).toBe(200);
    expect(res.body.workspaceId).toBe(ws.id);
    expect(res.body.captureApps).toBe(false);
    expect(res.body.captureTitles).toBe(false);
    expect(res.body.captureUrls).toBe(false);
    expect(res.body.retentionDaysScreenshots).toBe(60);
    // Row should now exist in the DB.
    const row = await prisma.workspacePolicy.findUnique({ where: { workspaceId: ws.id } });
    expect(row).not.toBeNull();
  });

  it('returns the same row on subsequent GETs (no duplicate inserts)', async () => {
    const { ws, admin } = await seedWorkspace();
    await request(app).get('/v1/admin/workspace-policy').set(bearer(admin.token));
    await request(app).get('/v1/admin/workspace-policy').set(bearer(admin.token));
    const rows = await prisma.workspacePolicy.findMany({ where: { workspaceId: ws.id } });
    expect(rows).toHaveLength(1);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/v1/admin/workspace-policy');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /v1/admin/workspace-policy', () => {
  it('lets ADMIN flip captureApps on', async () => {
    const { admin } = await seedWorkspace();
    const res = await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(bearer(admin.token))
      .send({ captureApps: true });
    expect(res.status).toBe(200);
    expect(res.body.captureApps).toBe(true);
    expect(res.body.captureTitles).toBe(false); // unchanged
  });

  it('lets ADMIN flip multiple flags at once', async () => {
    const { ws, admin } = await seedWorkspace();
    const res = await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(bearer(admin.token))
      .send({ captureApps: true, captureTitles: true, retentionDaysScreenshots: 30 });
    expect(res.status).toBe(200);
    expect(res.body.captureApps).toBe(true);
    expect(res.body.captureTitles).toBe(true);
    expect(res.body.retentionDaysScreenshots).toBe(30);
    const row = await prisma.workspacePolicy.findUnique({ where: { workspaceId: ws.id } });
    expect(row?.captureApps).toBe(true);
    expect(row?.captureTitles).toBe(true);
  });

  it('rejects MEMBER PATCH (admin-only)', async () => {
    const { member } = await seedWorkspace();
    const res = await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(bearer(member.token))
      .send({ captureApps: true });
    expect(res.status).toBe(403);
  });

  it('rejects an empty body', async () => {
    const { admin } = await seedWorkspace();
    const res = await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(bearer(admin.token))
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects retentionDaysScreenshots < 0', async () => {
    const { admin } = await seedWorkspace();
    const res = await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(bearer(admin.token))
      .send({ retentionDaysScreenshots: -7 });
    expect(res.status).toBe(400);
  });

  it('PATCH upserts when no row exists yet', async () => {
    const { ws, admin } = await seedWorkspace();
    // No GET first → first PATCH should create the row.
    expect(await prisma.workspacePolicy.findUnique({ where: { workspaceId: ws.id } })).toBeNull();
    const res = await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(bearer(admin.token))
      .send({ captureApps: true });
    expect(res.status).toBe(200);
    expect(await prisma.workspacePolicy.findUnique({ where: { workspaceId: ws.id } })).not.toBeNull();
  });
});

describe('POST /v1/activity-samples — policy-gated active fields', () => {
  const sample = (bucketStart: string) => ({
    id: ulid(),
    bucketStart,
    keystrokes: 5,
    clicks: 2,
    mouseDistancePx: 100,
    scrollEvents: 1,
    activeApp: 'Google Chrome',
    activeAppBundle: 'com.google.Chrome',
    activeTitle: 'Inbox · me@example.com',
    activeUrl: 'https://mail.google.com/inbox',
  });

  it('strips ALL active fields when captureApps is off (default)', async () => {
    const { ws, member } = await seedWorkspace();
    const t = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const res = await request(app)
      .post('/v1/activity-samples')
      .set(bearer(member.token))
      .send({ samples: [sample(t)] });
    expect(res.status).toBe(201);
    const row = await prisma.activitySample.findUnique({
      where: { userId_bucketStart: { userId: member.id, bucketStart: new Date(t) } },
    });
    expect(row?.activeApp).toBeNull();
    expect(row?.activeAppBundle).toBeNull();
    expect(row?.activeTitle).toBeNull();
    expect(row?.activeUrl).toBeNull();
    // The non-active fields still land.
    expect(row?.keystrokes).toBe(5);
    expect(ws.id).toBeTruthy();
  });

  it('keeps app + bundle but strips title + url when captureApps only', async () => {
    const { ws, admin, member } = await seedWorkspace();
    await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(bearer(admin.token))
      .send({ captureApps: true });
    const t = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const res = await request(app)
      .post('/v1/activity-samples')
      .set(bearer(member.token))
      .send({ samples: [sample(t)] });
    expect(res.status).toBe(201);
    const row = await prisma.activitySample.findUnique({
      where: { userId_bucketStart: { userId: member.id, bucketStart: new Date(t) } },
    });
    expect(row?.activeApp).toBe('Google Chrome');
    expect(row?.activeAppBundle).toBe('com.google.Chrome');
    expect(row?.activeTitle).toBeNull();
    expect(row?.activeUrl).toBeNull();
    expect(ws.id).toBeTruthy();
  });

  it('keeps everything when all flags are on', async () => {
    const { admin, member } = await seedWorkspace();
    await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(bearer(admin.token))
      .send({ captureApps: true, captureTitles: true, captureUrls: true });
    const t = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    await request(app)
      .post('/v1/activity-samples')
      .set(bearer(member.token))
      .send({ samples: [sample(t)] });
    const row = await prisma.activitySample.findUnique({
      where: { userId_bucketStart: { userId: member.id, bucketStart: new Date(t) } },
    });
    expect(row?.activeApp).toBe('Google Chrome');
    expect(row?.activeTitle).toBe('Inbox · me@example.com');
    expect(row?.activeUrl).toBe('https://mail.google.com/inbox');
  });

  it('re-strips when policy flips OFF and same minute is re-uploaded', async () => {
    const { admin, member } = await seedWorkspace();
    // Turn everything on.
    await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(bearer(admin.token))
      .send({ captureApps: true, captureTitles: true, captureUrls: true });
    const t = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    await request(app)
      .post('/v1/activity-samples')
      .set(bearer(member.token))
      .send({ samples: [sample(t)] });
    // Flip everything back off.
    await request(app)
      .patch('/v1/admin/workspace-policy')
      .set(bearer(admin.token))
      .send({ captureApps: false, captureTitles: false, captureUrls: false });
    // Re-upload the same bucket — upsert path. Active fields must be nulled.
    await request(app)
      .post('/v1/activity-samples')
      .set(bearer(member.token))
      .send({ samples: [sample(t)] });
    const row = await prisma.activitySample.findUnique({
      where: { userId_bucketStart: { userId: member.id, bucketStart: new Date(t) } },
    });
    expect(row?.activeApp).toBeNull();
    expect(row?.activeTitle).toBeNull();
    expect(row?.activeUrl).toBeNull();
  });
});
