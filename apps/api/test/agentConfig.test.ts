import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;

async function seedAgentConfig(input: {
  workspaceTimezone?: string;
  policy?: {
    defaultScreenshotIntervalMin: number;
    defaultIdleThresholdMin: number;
    captureApps?: boolean;
    captureTitles?: boolean;
    captureUrls?: boolean;
  };
  user?: {
    screenshotIntervalMin?: number | null;
    idleThresholdMin?: number | null;
    idleWarningSeconds?: number | null;
  };
}) {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const workspace = await prisma.workspace.create({
    data: {
      name: `WS-agent-config-${stamp}`,
      timezone: input.workspaceTimezone ?? 'UTC',
    },
  });
  if (input.policy) {
    await prisma.workspacePolicy.create({
      data: {
        workspaceId: workspace.id,
        defaultScreenshotIntervalMin: input.policy.defaultScreenshotIntervalMin,
        defaultIdleThresholdMin: input.policy.defaultIdleThresholdMin,
        captureApps: input.policy.captureApps ?? false,
        captureTitles: input.policy.captureTitles ?? false,
        captureUrls: input.policy.captureUrls ?? false,
      },
    });
  }
  const user = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      email: `agent-config-${stamp}@test.local`,
      name: 'Agent Config',
      role: 'MEMBER',
      passwordHash: 'x'.repeat(60),
      screenshotIntervalMin: input.user?.screenshotIntervalMin,
      idleThresholdMin: input.user?.idleThresholdMin,
      idleWarningSeconds: input.user?.idleWarningSeconds,
    },
  });
  return {
    user,
    token: signAccessToken({ sub: user.id, ws: workspace.id, role: 'MEMBER' }),
  };
}

describe('/v1/agent/config', () => {
  it('uses workspace policy defaults when member overrides are null', async () => {
    const s = await seedAgentConfig({
      policy: { defaultScreenshotIntervalMin: 2, defaultIdleThresholdMin: 7 },
      user: { screenshotIntervalMin: null, idleThresholdMin: null },
    });

    const res = await request(app).get('/v1/agent/config').set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.configVersion).toEqual(expect.any(String));
    expect(res.body.screenshotIntervalMin).toBe(2);
    expect(res.body.idleThresholdMin).toBe(7);
    expect(res.body.idleWarningSeconds).toBeNull();
    expect(res.body.captureApps).toBe(false);
    expect(res.body.captureTitles).toBe(false);
    expect(res.body.captureUrls).toBe(false);
    expect(res.body.todayLedgerMode).toBe('OFF');
    expect(res.body.configVersion).toContain('today-ledger:OFF');
  });

  it('gives per-member overrides priority over workspace policy defaults', async () => {
    const s = await seedAgentConfig({
      policy: { defaultScreenshotIntervalMin: 3, defaultIdleThresholdMin: 7 },
      user: { screenshotIntervalMin: 1, idleThresholdMin: 12 },
    });

    const res = await request(app).get('/v1/agent/config').set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.screenshotIntervalMin).toBe(1);
    expect(res.body.idleThresholdMin).toBe(12);
  });

  it('returns an enabled per-member idle warning and versions it', async () => {
    const s = await seedAgentConfig({
      policy: { defaultScreenshotIntervalMin: 3, defaultIdleThresholdMin: 5 },
      user: { idleWarningSeconds: 30 },
    });

    const res = await request(app).get('/v1/agent/config').set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.idleWarningSeconds).toBe(30);
    expect(res.body.configVersion).toContain('|30|');
  });

  it('defensively disables a stored warning that is not before the threshold', async () => {
    const s = await seedAgentConfig({
      policy: { defaultScreenshotIntervalMin: 3, defaultIdleThresholdMin: 1 },
      user: { idleWarningSeconds: 60 },
    });

    const res = await request(app).get('/v1/agent/config').set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.idleWarningSeconds).toBeNull();
  });

  it('returns workspace capture policy flags to the agent', async () => {
    const s = await seedAgentConfig({
      policy: {
        defaultScreenshotIntervalMin: 2,
        defaultIdleThresholdMin: 7,
        captureApps: true,
        captureTitles: true,
        captureUrls: false,
      },
      user: { screenshotIntervalMin: null, idleThresholdMin: null },
    });

    const res = await request(app).get('/v1/agent/config').set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.captureApps).toBe(true);
    expect(res.body.captureTitles).toBe(true);
    expect(res.body.captureUrls).toBe(false);
  });

  it('falls back to built-in defaults when no policy row exists', async () => {
    const s = await seedAgentConfig({});

    const res = await request(app).get('/v1/agent/config').set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.configVersion).toEqual(expect.any(String));
    expect(res.body.screenshotIntervalMin).toBe(3);
    expect(res.body.idleThresholdMin).toBe(5);
    expect(res.body.captureApps).toBe(false);
    expect(res.body.captureTitles).toBe(false);
    expect(res.body.captureUrls).toBe(false);
  });

  it('returns the canonical workspace timezone and versions config changes with it', async () => {
    const s = await seedAgentConfig({ workspaceTimezone: 'Asia/Kolkata' });

    const res = await request(app).get('/v1/agent/config').set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.workspaceTimezone).toBe('Asia/Kolkata');
    expect(res.body.configVersion).toContain('Asia/Kolkata');
  });
});
