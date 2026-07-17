/**
 * An agent is online when its server-recorded heartbeat is recent. This is a
 * presence signal only: an online agent may be tracking, paused, or idle.
 */
export const AGENT_HEARTBEAT_FRESH_MS = 3 * 60 * 1000;

export type AgentPresence = 'ONLINE' | 'OFFLINE';

export function isAgentHeartbeatFresh(lastSeenAt: Date | null, now = new Date()): boolean {
  return lastSeenAt !== null && lastSeenAt.getTime() >= now.getTime() - AGENT_HEARTBEAT_FRESH_MS;
}

export function agentPresence(lastSeenAt: Date | null, now = new Date()): AgentPresence {
  return isAgentHeartbeatFresh(lastSeenAt, now) ? 'ONLINE' : 'OFFLINE';
}
