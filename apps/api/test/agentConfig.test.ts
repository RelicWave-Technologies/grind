import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { signAccessToken } from '../src/lib/jwt';

const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;

async function seedAgentConfig(input: {
  policy?: { defaultScreenshotIntervalMin: number; defaultIdleThresholdMin: number };
  user?: { screenshotIntervalMin?: number | null; idleThresholdMin?: number | null };
}) {
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  const workspace = await prisma.workspace.create({ data: { name: `WS-agent-config-${stamp}` } });
  if (input.policy) {
    await prisma.workspacePolicy.create({
      data: {
        workspaceId: workspace.id,
        defaultScreenshotIntervalMin: input.policy.defaultScreenshotIntervalMin,
        defaultIdleThresholdMin: input.policy.defaultIdleThresholdMin,
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
      policy: { defaultScreenshotIntervalMin: 45, defaultIdleThresholdMin: 7 },
      user: { screenshotIntervalMin: null, idleThresholdMin: null },
    });

    const res = await request(app).get('/v1/agent/config').set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.screenshotIntervalMin).toBe(45);
    expect(res.body.idleThresholdMin).toBe(7);
  });

  it('gives per-member overrides priority over workspace policy defaults', async () => {
    const s = await seedAgentConfig({
      policy: { defaultScreenshotIntervalMin: 45, defaultIdleThresholdMin: 7 },
      user: { screenshotIntervalMin: 90, idleThresholdMin: 12 },
    });

    const res = await request(app).get('/v1/agent/config').set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.screenshotIntervalMin).toBe(90);
    expect(res.body.idleThresholdMin).toBe(12);
  });

  it('falls back to built-in defaults when no policy row exists', async () => {
    const s = await seedAgentConfig({});

    const res = await request(app).get('/v1/agent/config').set(auth(s.token));

    expect(res.status).toBe(200);
    expect(res.body.screenshotIntervalMin).toBe(180);
    expect(res.body.idleThresholdMin).toBe(5);
  });
});
