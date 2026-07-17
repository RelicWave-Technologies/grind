import { describe, expect, it } from 'vitest';
import { agentPresence, AGENT_HEARTBEAT_FRESH_MS, isAgentHeartbeatFresh } from './agentPresence';

describe('agent presence', () => {
  const now = new Date('2026-07-17T12:00:00.000Z');

  it('treats a fresh running agent as online', () => {
    const lastSeenAt = new Date(now.getTime() - AGENT_HEARTBEAT_FRESH_MS);

    expect(isAgentHeartbeatFresh(lastSeenAt, now)).toBe(true);
    expect(agentPresence(lastSeenAt, 'RUNNING', now)).toBe('ONLINE');
  });

  it('treats an idle or paused agent as offline even while its heartbeat is fresh', () => {
    const fresh = new Date(now.getTime() - 1);

    expect(agentPresence(fresh, 'IDLE', now)).toBe('OFFLINE');
    expect(agentPresence(fresh, 'PAUSED_IDLE', now)).toBe('OFFLINE');
    expect(agentPresence(fresh, 'PAUSED_PERMISSION', now)).toBe('OFFLINE');
  });

  it('treats a missing or expired running heartbeat as offline', () => {
    const expired = new Date(now.getTime() - AGENT_HEARTBEAT_FRESH_MS - 1);

    expect(agentPresence(null, 'RUNNING', now)).toBe('OFFLINE');
    expect(agentPresence(expired, 'RUNNING', now)).toBe('OFFLINE');
  });
});
