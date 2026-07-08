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
      larkTaskGuid: null,
      startedAt: 1,
      workedMs: 10,
      paused: false,
    };
    expect(buildHeartbeatRequest({ agentVersion: '0.0.2', platform: 'darwin', timerStatus: status })).toMatchObject({
      state: 'RUNNING',
      activeEntryId: 'entry-1',
    });
  });

  it('maps paused running timer status to PAUSED_IDLE', () => {
    const status: TimerStatus = {
      state: 'RUNNING',
      entryId: 'entry-2',
      larkTaskGuid: 'task',
      startedAt: 1,
      workedMs: 10,
      paused: true,
    };
    expect(buildHeartbeatRequest({ agentVersion: '0.0.2', platform: 'win32', timerStatus: status })).toMatchObject({
      state: 'PAUSED_IDLE',
      activeEntryId: 'entry-2',
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

  it('normalizes unknown node platforms to linux', () => {
    expect(currentPlatform('darwin')).toBe('darwin');
    expect(currentPlatform('win32')).toBe('win32');
    expect(currentPlatform('freebsd')).toBe('linux');
  });
});
