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
