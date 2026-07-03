import type { HeartbeatResponse } from '@grind/types';
import { AGENT_VERSION, HEARTBEAT_INTERVAL_MS } from '../env';
import { log } from '../logger';
import { api, UnauthorizedError } from './apiClient';
import { isLoggedIn } from './auth';
import { drainActivityNow } from './activity';
import { drainTimerSyncNow, getTimerService } from './timer';
import { buildHeartbeatRequest, currentPlatform } from './heartbeatPayload';
import type { TimerSyncDrainReason } from './timer/syncDrain';
import { getAgentConfigVersion, refreshAgentConfig } from './agentConfig';

let timer: NodeJS.Timeout | null = null;
let lastHeartbeatAt: string | null = null;

function requestTimerDrain(reason: TimerSyncDrainReason): void {
  void Promise.resolve()
    .then(() => drainTimerSyncNow(reason))
    .catch((err) => log.warn('heartbeat timer drain trigger failed', { reason, err: String(err) }));
}

function requestActivityDrain(reason: 'auth' | 'heartbeat'): void {
  void Promise.resolve()
    .then(() => drainActivityNow(reason))
    .catch((err) => log.warn('heartbeat activity drain trigger failed', { reason, err: String(err) }));
}

function requestAgentConfigRefresh(serverVersion: string): void {
  if (!serverVersion || serverVersion === getAgentConfigVersion()) return;
  void Promise.resolve()
    .then(() => refreshAgentConfig())
    .catch((err) => log.warn('heartbeat config refresh trigger failed', { err: String(err) }));
}

async function tick(): Promise<void> {
  const body = buildHeartbeatRequest({
    agentVersion: AGENT_VERSION,
    platform: currentPlatform(),
    timerStatus: getTimerService().status(),
  });
  try {
    const res = await api<HeartbeatResponse>('/v1/agent/heartbeat', { method: 'POST', body });
    lastHeartbeatAt = res.serverTime;
    log.debug('heartbeat ok', { serverTime: res.serverTime, configVersion: res.configVersion });
    requestAgentConfigRefresh(res.configVersion);
    requestTimerDrain('heartbeat');
    requestActivityDrain('heartbeat');
  } catch (err: unknown) {
    if (err instanceof UnauthorizedError) {
      log.warn('heartbeat unauthorized; stopping');
      stopHeartbeat();
    } else {
      log.warn('heartbeat failed', { err: String(err) });
    }
  }
}

export function sendHeartbeatNow(): void {
  void tick();
}

export function startHeartbeat(): void {
  if (timer) return;
  void tick();
  requestTimerDrain('auth');
  requestActivityDrain('auth');
  timer = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
  log.info('heartbeat started', { intervalMs: HEARTBEAT_INTERVAL_MS });
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info('heartbeat stopped');
  }
}

export async function startHeartbeatIfAuthed(): Promise<void> {
  if (await isLoggedIn()) startHeartbeat();
}

export function getStatus(): { lastHeartbeatAt: string | null; running: boolean } {
  return { lastHeartbeatAt, running: timer !== null };
}
