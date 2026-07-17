import { describe, expect, it } from 'vitest';
import { agentPresence, AGENT_HEARTBEAT_FRESH_MS, isAgentHeartbeatFresh } from './agentPresence';

describe('agent presence', () => {
  const now = new Date('2026-07-17T12:00:00.000Z');

  it('treats a heartbeat within three minutes as online', () => {
    const lastSeenAt = new Date(now.getTime() - AGENT_HEARTBEAT_FRESH_MS);

    expect(isAgentHeartbeatFresh(lastSeenAt, now)).toBe(true);
    expect(agentPresence(lastSeenAt, now)).toBe('ONLINE');
  });

  it('treats a missing or expired heartbeat as offline', () => {
    const expired = new Date(now.getTime() - AGENT_HEARTBEAT_FRESH_MS - 1);

    expect(agentPresence(null, now)).toBe('OFFLINE');
    expect(agentPresence(expired, now)).toBe('OFFLINE');
  });
});
