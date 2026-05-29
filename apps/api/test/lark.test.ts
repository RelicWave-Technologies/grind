import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';

let app: Express;
beforeAll(() => {
  app = buildApp();
});

describe('GET /v1/lark/status', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/v1/lark/status');
    expect(res.status).toBe(401);
  });

  it('reports not-configured gracefully when creds are absent', async () => {
    // In test env LARK_APP_ID etc. are unset, so the integration is disabled.
    const { accessToken } = await seedUser();
    const res = await request(app)
      .get('/v1/lark/status')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: false,
      connected: false,
      reauthRequired: false,
      scopes: [],
    });
  });
});

describe('GET /v1/lark/oauth/start', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/v1/lark/oauth/start');
    expect(res.status).toBe(401);
  });

  it('returns 503 when Lark is not configured', async () => {
    const { accessToken } = await seedUser();
    const res = await request(app)
      .get('/v1/lark/oauth/start')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'lark_not_configured' });
  });
});

describe('GET /v1/lark/oauth/callback', () => {
  it('is reachable WITHOUT a Grind token (browser-facing) and degrades gracefully', async () => {
    // Unconfigured in test env → 503 HTML, but importantly NOT a 401.
    const res = await request(app).get('/v1/lark/oauth/callback?code=x&state=y');
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});

describe('GET /v1/lark/my-tasks', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/v1/lark/my-tasks');
    expect(res.status).toBe(401);
  });

  it('returns 503 when Lark is not configured', async () => {
    const { accessToken } = await seedUser();
    const res = await request(app)
      .get('/v1/lark/my-tasks')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'lark_not_configured' });
  });
});

describe('POST /v1/lark/disconnect', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/v1/lark/disconnect');
    expect(res.status).toBe(401);
  });

  it('is a no-op ok when Lark is not configured', async () => {
    const { accessToken } = await seedUser();
    const res = await request(app)
      .post('/v1/lark/disconnect')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});
