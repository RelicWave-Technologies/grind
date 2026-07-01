import type { AgentState, HeartbeatRequest, Platform } from '@grind/types';
import type { TimerStatus } from './timer';

export function currentPlatform(nodePlatform: NodeJS.Platform = process.platform): Platform {
  if (nodePlatform === 'darwin') return 'darwin';
  if (nodePlatform === 'win32') return 'win32';
  return 'linux';
}

export function agentStateFromTimer(status: TimerStatus): AgentState {
  if (status.state !== 'RUNNING') return 'IDLE';
  return status.paused ? 'PAUSED_IDLE' : 'RUNNING';
}

export function buildHeartbeatRequest(args: {
  agentVersion: string;
  platform: Platform;
  timerStatus: TimerStatus;
}): HeartbeatRequest {
  const { agentVersion, platform, timerStatus } = args;
  return {
    agentVersion,
    platform,
    state: agentStateFromTimer(timerStatus),
    activeEntryId: timerStatus.state === 'RUNNING' ? timerStatus.entryId : null,
  };
}
