import { app } from 'electron';
import type { DesktopPermissionSnapshot, HeartbeatResponse } from '@grind/types';
import { AGENT_VERSION, HEARTBEAT_INTERVAL_MS } from '../env';
import { log } from '../logger';
import { api, UnauthorizedError } from './apiClient';
import { isLoggedIn } from './auth';
import { drainActivityNow } from './activity';
import { drainTimerSyncNow, getTimerService } from './timer';
import { buildHeartbeatRequest, currentPlatform } from './heartbeatPayload';
import type { TimerSyncDrainReason } from './timer/syncDrain';
import { getAgentConfigVersion, refreshAgentConfig } from './agentConfig';
import { broadcast } from '../broadcast';
import { getTrackingReadinessService } from './trackingReadiness';
import { getLaunchAtLoginService } from './launchAtLogin';

let timer: NodeJS.Timeout | null = null;
let lastHeartbeatAt: string | null = null;

function agentVersion(): string {
  try {
    return app.getVersion() || AGENT_VERSION;
  } catch {
    return AGENT_VERSION;
  }
}

async function currentPermissionSnapshot(): Promise<DesktopPermissionSnapshot> {
  return (await getTrackingReadinessService().inspect()).permissions;
}

function currentStartupSnapshot() {
  const service = getLaunchAtLoginService();
  const health = service.inspect();
  return {
    state: health.state,
    ready: health.ready,
    openedAtLogin: health.openedAtLogin,
    origin: service.launchOrigin(),
  };
}

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
  try {
    await drainTimerSyncNow('heartbeat');
    const timerService = getTimerService();
    const timerStatus = timerService.status();
    if (timerStatus.state === 'RUNNING' && !timerStatus.paused) timerService.heartbeat();
    const body = buildHeartbeatRequest({
      agentVersion: agentVersion(),
      platform: currentPlatform(),
      timerStatus,
      observedAt: Date.now(),
      permissions: await currentPermissionSnapshot(),
      startup: currentStartupSnapshot(),
    });
    const res = await api<HeartbeatResponse>('/v1/agent/heartbeat', { method: 'POST', body });
    lastHeartbeatAt = res.serverTime;
    log.debug('heartbeat ok', { serverTime: res.serverTime, configVersion: res.configVersion });
    if (res.timer?.disposition === 'needs_sync') requestTimerDrain('heartbeat');
    if (res.timer?.disposition === 'finalized' || res.timer?.disposition === 'conflict') {
      log.warn('server rejected active timer checkpoint', {
        entryId: res.timer.entryId,
        disposition: res.timer.disposition,
        endedAt: res.timer.endedAt,
        closeReason: res.timer.closeReason,
      });
      if (res.timer.endedAt) {
        const status = getTimerService().acceptServerFinalization(res.timer.entryId, new Date(res.timer.endedAt).getTime());
        broadcast('timer:status:push', status);
      }
    }
    requestAgentConfigRefresh(res.configVersion);
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
