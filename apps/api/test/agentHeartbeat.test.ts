import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import { fakeUlid, seedUser } from './helpers';

const app = buildApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('POST /v1/agent/heartbeat', () => {
  it('persists the agent timer state used by live overview status', async () => {
    const user = await seedUser();
    await prisma.timeEntry.create({
      data: {
        id: 'entry-paused',
        clientUuid: fakeUlid('heartbeat-paused-client'),
        userId: user.userId,
        source: 'AUTO',
        startedAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await request(app)
      .post('/v1/agent/heartbeat')
      .set(bearer(user.accessToken))
      .send({
        agentVersion: '0.0.2',
        platform: 'darwin',
        state: 'PAUSED_IDLE',
        activeEntryId: 'entry-paused',
        permissions: {
          screen: { status: 'granted', health: 'ok', state: 'ok' },
          accessibility: {
            trusted: true,
            ready: true,
            recording: false,
            capturing: false,
            hookRunning: false,
          },
        },
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
        agentScreenPermissionStatus: true,
        agentScreenCaptureHealth: true,
        agentScreenPermissionState: true,
        agentAccessibilityTrusted: true,
        agentAccessibilityReady: true,
        agentAccessibilityRecording: true,
        agentAccessibilityCapturing: true,
        agentAccessibilityHookRunning: true,
        agentPermissionsUpdatedAt: true,
      },
    });
    expect(row.agentLastSeenAt).toBeInstanceOf(Date);
    expect(row.agentState).toBe('PAUSED_IDLE');
    expect(row.agentVersion).toBe('0.0.2');
    expect(row.agentPlatform).toBe('darwin');
    expect(row.agentActiveEntryId).toBe('entry-paused');
    expect(row.agentScreenPermissionStatus).toBe('granted');
    expect(row.agentScreenCaptureHealth).toBe('ok');
    expect(row.agentScreenPermissionState).toBe('ok');
    expect(row.agentAccessibilityTrusted).toBe(true);
    expect(row.agentAccessibilityReady).toBe(true);
    expect(row.agentAccessibilityRecording).toBe(false);
    expect(row.agentAccessibilityCapturing).toBe(false);
    expect(row.agentAccessibilityHookRunning).toBe(false);
    expect(row.agentPermissionsUpdatedAt).toBeInstanceOf(Date);
  });

  it('defaults old agents without state or permissions to IDLE', async () => {
    const user = await seedUser();

    const res = await request(app)
      .post('/v1/agent/heartbeat')
      .set(bearer(user.accessToken))
      .send({ agentVersion: '0.0.1', platform: 'linux' });

    expect(res.status).toBe(200);
    expect(res.body.configVersion).toEqual(expect.any(String));
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: {
        agentState: true,
        agentActiveEntryId: true,
        agentScreenPermissionStatus: true,
        agentAccessibilityTrusted: true,
        agentPermissionsUpdatedAt: true,
      },
    });
    expect(row.agentState).toBe('IDLE');
    expect(row.agentActiveEntryId).toBeNull();
    expect(row.agentScreenPermissionStatus).toBeNull();
    expect(row.agentAccessibilityTrusted).toBeNull();
    expect(row.agentPermissionsUpdatedAt).toBeNull();
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
      data: { screenshotIntervalMin: 2 },
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
        defaultScreenshotIntervalMin: 2,
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
