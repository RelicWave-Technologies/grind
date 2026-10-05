import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { reportError } from '../src/lib/errorReporter';
import { seedUser } from './helpers';

/**
 * Errors raised before a route runs (body-parser, CORS) carry their own 4xx
 * status. They used to come back as 500 and page Sentry.
 */

vi.mock('../src/lib/errorReporter', () => ({ reportError: vi.fn(async () => {}) }));

const app = buildApp();

afterEach(() => {
  // None of these are server faults: nothing may reach Sentry.
  expect(reportError).not.toHaveBeenCalled();
  vi.mocked(reportError).mockClear();
});

describe('client errors keep their status', () => {
  it('malformed JSON is a 400, not a 500', async () => {
    const { accessToken } = await seedUser();
    const res = await request(app)
      .post('/v1/agent/app-icons')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Content-Type', 'application/json')
      .send('{"icons": [');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  it('an oversized body is a 413', async () => {
    const { accessToken } = await seedUser();
    const res = await request(app)
      .post('/v1/agent/app-icons')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ icons: [{ bundleId: 'com.big', app: 'Big', pngBase64: 'A'.repeat(70_000) }] });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('payload_too_large');
  });

  it('a disallowed browser origin is a 403', async () => {
    const prev = process.env.DASHBOARD_URL;
    process.env.DASHBOARD_URL = 'https://dash.example';
    try {
      const corsApp = buildApp();
      const res = await request(corsApp).get('/health').set('Origin', 'https://evil.example');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('cors_rejected');
      const ok = await request(corsApp).get('/health').set('Origin', 'https://dash.example');
      expect(ok.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_URL;
      else process.env.DASHBOARD_URL = prev;
    }
  });
});

describe('POST /v1/agent/app-icons is insert-only', () => {
  beforeEach(async () => {
    await prisma.appIcon.deleteMany({ where: { bundleId: { startsWith: 'test.icons.' } } });
  });

  async function upload(pngBase64: string, bundleId: string) {
    const { accessToken, workspaceId } = await seedUser();
    await prisma.workspacePolicy.upsert({
      where: { workspaceId },
      create: { workspaceId, captureApps: true },
      update: { captureApps: true },
    });
    return request(app)
      .post('/v1/agent/app-icons')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ icons: [{ bundleId, app: 'Thing', pngBase64 }] });
  }

  it('keeps the first icon for a bundle; another workspace cannot replace it', async () => {
    const first = Buffer.from('first-icon').toString('base64');
    const second = Buffer.from('other-icon').toString('base64');
    const a = await upload(first, 'test.icons.one');
    expect(a.status).toBe(200);
    expect(a.body.stored).toBe(1);

    const b = await upload(second, 'test.icons.one');
    expect(b.status).toBe(200);
    expect(b.body.stored).toBe(0);

    const row = await prisma.appIcon.findUniqueOrThrow({ where: { bundleId: 'test.icons.one' } });
    expect(Buffer.from(row.png).toString()).toBe('first-icon');
  });
});

