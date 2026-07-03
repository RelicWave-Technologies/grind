import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { seedUser } from './helpers';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('POST /v1/agent/heartbeat', () => {
  it('persists the agent timer state used by live overview status', async () => {
    const user = await seedUser();

    const res = await request(app)
      .post('/v1/agent/heartbeat')
      .set(bearer(user.accessToken))
      .send({
        agentVersion: '0.0.2',
        platform: 'darwin',
        state: 'PAUSED_IDLE',
        activeEntryId: 'entry-paused',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.configVersion).toEqual(expect.any(String));

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: {
        agentLastSeenAt: true,
        agentState: true,
        agentVersion: true,
        agentPlatform: true,
        agentActiveEntryId: true,
      },
    });
    expect(row.agentLastSeenAt).toBeInstanceOf(Date);
    expect(row.agentState).toBe('PAUSED_IDLE');
    expect(row.agentVersion).toBe('0.0.2');
    expect(row.agentPlatform).toBe('darwin');
    expect(row.agentActiveEntryId).toBe('entry-paused');
  });

  it('defaults old agents without state to IDLE', async () => {
    const user = await seedUser();

    const res = await request(app)
      .post('/v1/agent/heartbeat')
      .set(bearer(user.accessToken))
      .send({ agentVersion: '0.0.1', platform: 'linux' });

    expect(res.status).toBe(200);
    expect(res.body.configVersion).toEqual(expect.any(String));
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { agentState: true, agentActiveEntryId: true },
    });
    expect(row.agentState).toBe('IDLE');
    expect(row.agentActiveEntryId).toBeNull();
  });

  it('changes configVersion after effective member timing changes', async () => {
    const user = await seedUser();

    const first = await request(app)
      .post('/v1/agent/heartbeat')
      .set(bearer(user.accessToken))
      .send({ agentVersion: '0.0.2', platform: 'darwin' });
    expect(first.status).toBe(200);

    await prisma.user.update({
      where: { id: user.userId },
      data: { screenshotIntervalMin: 30 },
    });

    const second = await request(app)
      .post('/v1/agent/heartbeat')
      .set(bearer(user.accessToken))
      .send({ agentVersion: '0.0.2', platform: 'darwin' });
    expect(second.status).toBe(200);
    expect(second.body.configVersion).not.toBe(first.body.configVersion);
  });

  it('changes configVersion after workspace policy changes', async () => {
    const user = await seedUser();

    const first = await request(app)
      .post('/v1/agent/heartbeat')
      .set(bearer(user.accessToken))
      .send({ agentVersion: '0.0.2', platform: 'darwin' });
    expect(first.status).toBe(200);

    await prisma.workspacePolicy.create({
      data: {
        workspaceId: user.workspaceId,
        defaultScreenshotIntervalMin: 45,
        defaultIdleThresholdMin: 10,
        captureApps: true,
      },
    });

    const second = await request(app)
      .post('/v1/agent/heartbeat')
      .set(bearer(user.accessToken))
      .send({ agentVersion: '0.0.2', platform: 'darwin' });
    expect(second.status).toBe(200);
    expect(second.body.configVersion).not.toBe(first.body.configVersion);
  });
});
