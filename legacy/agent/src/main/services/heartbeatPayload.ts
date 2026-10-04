import {
  TIMER_TRACKING_PROTOCOL_VERSION,
  type AgentState,
  type DesktopPermissionSnapshot,
  type HeartbeatRequest,
  type LaunchAtLoginSnapshot,
  type Platform,
} from '@grind/types';
import type { TimerStatus } from './timer';

export function currentPlatform(nodePlatform: NodeJS.Platform = process.platform): Platform {
  if (nodePlatform === 'darwin') return 'darwin';
  if (nodePlatform === 'win32') return 'win32';
  return 'linux';
}

export function agentStateFromTimer(status: TimerStatus): AgentState {
  if (status.state !== 'RUNNING') return 'IDLE';
  if (!status.paused) return 'RUNNING';
  return status.pauseReason === 'PERMISSION_REQUIRED' ? 'PAUSED_PERMISSION' : 'PAUSED_IDLE';
}

export function buildHeartbeatRequest(args: {
  agentVersion: string;
  platform: Platform;
  timerStatus: TimerStatus;
  permissions?: DesktopPermissionSnapshot;
  startup?: LaunchAtLoginSnapshot;
  observedAt?: number;
}): HeartbeatRequest {
  const { agentVersion, platform, timerStatus, permissions, startup } = args;
  const timerCheckpoint = timerStatus.state === 'RUNNING'
    ? {
        entryId: timerStatus.entryId,
        revision: Math.max(1, timerStatus.revision),
        state: agentStateFromTimer(timerStatus) as 'RUNNING' | 'PAUSED_IDLE' | 'PAUSED_PERMISSION',
        observedAt: new Date(args.observedAt ?? Date.now()).toISOString(),
      }
    : null;
  return {
    agentVersion,
    platform,
    state: agentStateFromTimer(timerStatus),
    activeEntryId: timerStatus.state === 'RUNNING' ? timerStatus.entryId : null,
    trackingProtocolVersion: TIMER_TRACKING_PROTOCOL_VERSION,
    timerCheckpoint,
    ...(permissions ? { permissions } : {}),
    ...(startup ? { startup } : {}),
  };
}
