import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';
import { verifyOAuthState } from '../src/lark';

let app: Express;
beforeAll(() => {
  app = buildApp();
});

function configureLarkConnect(): void {
  process.env.LARK_APP_ID = 'cli_test';
  process.env.LARK_APP_SECRET = 'secret';
  process.env.LARK_TOKEN_KEY = '01234567890123456789012345678901';
  process.env.LARK_ACCOUNTS_HOST = 'https://accounts.larksuite.com';
  process.env.LARK_LOGIN_REDIRECT_URI = 'http://localhost:4000/v1/auth/lark/callback';
  process.env.LARK_CONNECT_REDIRECT_URI = 'http://localhost:4000/v1/lark/oauth/callback';
  process.env.LARK_OAUTH_REDIRECT_URI = 'http://localhost:4000/v1/auth/lark/callback';
}

function clearLarkConnect(): void {
  delete process.env.LARK_APP_ID;
  delete process.env.LARK_APP_SECRET;
  delete process.env.LARK_TOKEN_KEY;
  delete process.env.LARK_ACCOUNTS_HOST;
  delete process.env.LARK_LOGIN_REDIRECT_URI;
  delete process.env.LARK_CONNECT_REDIRECT_URI;
  delete process.env.LARK_OAUTH_REDIRECT_URI;
}

afterEach(() => {
  clearLarkConnect();
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

  it('uses the connect callback URI and returns to the Timo app when requested', async () => {
    configureLarkConnect();
    const { accessToken, user } = await seedUser();
    const res = await request(app)
      .get('/v1/lark/oauth/start?return_to=agent&callback_scheme=timo')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin).toBe('https://accounts.larksuite.com');
    expect(url.searchParams.get('client_id')).toBe('cli_test');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:4000/v1/lark/oauth/callback');

    const state = verifyOAuthState(url.searchParams.get('state')!);
    expect(state).toMatchObject({ sub: user.id, returnTo: 'agent', agentCallbackScheme: 'timo' });
  });

  it('does not treat a login callback URI as a valid task-connect callback', async () => {
    configureLarkConnect();
    delete process.env.LARK_CONNECT_REDIRECT_URI;
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
