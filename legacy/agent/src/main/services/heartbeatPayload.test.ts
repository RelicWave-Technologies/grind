import { describe, expect, it } from 'vitest';
import { agentStateFromTimer, buildHeartbeatRequest, currentPlatform } from './heartbeatPayload';
import type { TimerStatus } from './timer';

describe('heartbeat payload', () => {
  it('maps idle timer status to IDLE with no active entry', () => {
    const status: TimerStatus = { state: 'IDLE', workedMs: 0 };
    expect(agentStateFromTimer(status)).toBe('IDLE');
    expect(buildHeartbeatRequest({ agentVersion: '0.0.2', platform: 'darwin', timerStatus: status })).toMatchObject({
      state: 'IDLE',
      activeEntryId: null,
    });
  });

  it('maps accruing timer status to RUNNING', () => {
    const status: TimerStatus = {
      state: 'RUNNING',
      entryId: 'entry-1',
      revision: 7,
      larkTaskGuid: null,
      startedAt: 1,
      segmentStartedAt: 1,
      workedMs: 10,
      paused: false,
      pauseReason: null,
    };
    expect(buildHeartbeatRequest({ agentVersion: '0.0.2', platform: 'darwin', timerStatus: status, observedAt: 1000 })).toMatchObject({
      state: 'RUNNING',
      activeEntryId: 'entry-1',
      trackingProtocolVersion: 2,
      timerCheckpoint: {
        entryId: 'entry-1',
        revision: 7,
        state: 'RUNNING',
        observedAt: new Date(1000).toISOString(),
      },
    });
  });

  it('maps paused running timer status to PAUSED_IDLE', () => {
    const status: TimerStatus = {
      state: 'RUNNING',
      entryId: 'entry-2',
      revision: 8,
      larkTaskGuid: 'task',
      startedAt: 1,
      segmentStartedAt: null,
      workedMs: 10,
      paused: true,
      pauseReason: 'IDLE',
    };
    expect(buildHeartbeatRequest({ agentVersion: '0.0.2', platform: 'win32', timerStatus: status, observedAt: 2000 })).toMatchObject({
      state: 'PAUSED_IDLE',
      activeEntryId: 'entry-2',
      timerCheckpoint: {
        entryId: 'entry-2',
        revision: 8,
        state: 'PAUSED_IDLE',
        observedAt: new Date(2000).toISOString(),
      },
    });
  });

  it('keeps an explicit user pause backward-compatible as PAUSED_IDLE', () => {
    const status: TimerStatus = {
      state: 'RUNNING',
      entryId: 'entry-manual',
      revision: 9,
      larkTaskGuid: 'task',
      startedAt: 1,
      segmentStartedAt: null,
      workedMs: 10,
      paused: true,
      pauseReason: 'MANUAL',
    };

    expect(buildHeartbeatRequest({ agentVersion: '0.0.2', platform: 'darwin', timerStatus: status })).toMatchObject({
      state: 'PAUSED_IDLE',
      activeEntryId: 'entry-manual',
      timerCheckpoint: { state: 'PAUSED_IDLE' },
    });
  });

  it('distinguishes a permission-enforced pause from ordinary idle', () => {
    const status: TimerStatus = {
      state: 'RUNNING',
      entryId: 'entry-permission',
      revision: 9,
      larkTaskGuid: 'task',
      startedAt: 1,
      segmentStartedAt: null,
      workedMs: 10,
      paused: true,
      pauseReason: 'PERMISSION_REQUIRED',
    };

    expect(buildHeartbeatRequest({ agentVersion: '0.0.2', platform: 'darwin', timerStatus: status })).toMatchObject({
      state: 'PAUSED_PERMISSION',
      timerCheckpoint: { state: 'PAUSED_PERMISSION' },
    });
  });

  it('includes the current permission snapshot when provided', () => {
    const status: TimerStatus = { state: 'IDLE', workedMs: 0 };
    expect(
      buildHeartbeatRequest({
        agentVersion: '0.0.2',
        platform: 'darwin',
        timerStatus: status,
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
      }),
    ).toMatchObject({
      permissions: {
        screen: { status: 'granted', health: 'ok', state: 'ok' },
        accessibility: { trusted: true, ready: true },
      },
    });
  });

  it('includes launch-at-login health when provided', () => {
    const status: TimerStatus = { state: 'IDLE', workedMs: 0 };
    expect(
      buildHeartbeatRequest({
        agentVersion: '0.0.2',
        platform: 'win32',
        timerStatus: status,
        startup: {
          state: 'NEEDS_REPAIR',
          ready: false,
          openedAtLogin: false,
          origin: 'USER',
        },
      }),
    ).toMatchObject({
      startup: {
        state: 'NEEDS_REPAIR',
        ready: false,
        openedAtLogin: false,
        origin: 'USER',
      },
    });
  });

  it('normalizes unknown node platforms to linux', () => {
    expect(currentPlatform('darwin')).toBe('darwin');
    expect(currentPlatform('win32')).toBe('win32');
    expect(currentPlatform('freebsd')).toBe('linux');
  });
});
