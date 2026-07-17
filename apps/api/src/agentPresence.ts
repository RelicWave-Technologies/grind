import type { AgentRuntimeState } from '@grind/db';

/**
 * The People table's Online state means a person is actively tracking, not
 * merely that their Timo desktop app is still connected in the background.
 */
export const AGENT_HEARTBEAT_FRESH_MS = 3 * 60 * 1000;

export type AgentPresence = 'ONLINE' | 'OFFLINE';
export type { AgentRuntimeState } from '@grind/db';

export function isAgentHeartbeatFresh(lastSeenAt: Date | null, now = new Date()): boolean {
  return lastSeenAt !== null && lastSeenAt.getTime() >= now.getTime() - AGENT_HEARTBEAT_FRESH_MS;
}

export function agentPresence(
  lastSeenAt: Date | null,
  agentState: AgentRuntimeState,
  now = new Date(),
): AgentPresence {
  return agentState === 'RUNNING' && isAgentHeartbeatFresh(lastSeenAt, now) ? 'ONLINE' : 'OFFLINE';
}
