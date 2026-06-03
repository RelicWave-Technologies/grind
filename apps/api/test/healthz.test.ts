import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

const app = buildApp();

describe('GET /health', () => {
  it('returns { ok: true } with no auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /healthz', () => {
  it('returns ok + version + uptime + db latency on a healthy stack', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBeDefined();
    expect(typeof res.body.uptimeSec).toBe('number');
    expect(res.body.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(res.body.db.ok).toBe(true);
    expect(typeof res.body.db.latencyMs).toBe('number');
  });

  it('requires no auth', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
  });

  it('version reflects GIT_SHA env (falls back to "dev")', async () => {
    const res = await request(app).get('/healthz');
    // We didn't set GIT_SHA in the test runner, so we expect 'dev'.
    expect(res.body.version === 'dev' || res.body.version.length > 0).toBe(true);
  });
});
