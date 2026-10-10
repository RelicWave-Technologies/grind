import { release } from 'node:os';
import type { DesktopPermissionSnapshot, HeartbeatResponse } from '@grind/types';
import { HEARTBEAT_INTERVAL_MS } from '../env';
import { log } from '../logger';
import { hasDeferredServerClockCorrection, noteServerTime, serverAlignedNow, serverClockOffsetMs } from './serverClock';
import { api } from './apiClient';
import { drainActivityNow } from './activity';
import { drainTimerSyncNow, getTimerService } from './timer';
import { buildHeartbeatRequest } from './heartbeatPayload';
import { agentVersion, currentPlatform } from './agentIdentity';
import type { TimerSyncDrainReason } from './timer/syncDrain';
import { isClosedForSilence } from './timer/serverClose';
import { getAgentConfigVersion, refreshAgentConfig } from './agentConfig';
import { broadcast } from '../broadcast';
import { getTrackingReadinessService } from './trackingReadiness';
import { getLaunchAtLoginService } from './launchAtLogin';
import { handleRemoteCommands } from './remoteCommands';
import { getUpdateDiagnostics } from './updates/diagnostics';
import { getScreenshotDiagnostics } from './capture/diagnostics';

let timer: NodeJS.Timeout | null = null;

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

function currentDiagnostics() {
  const backlog = getTimerService().syncBacklog();
  return {
    // getSystemVersion is Electron's (macOS "12.7.6"); plain Node has only the kernel release.
    osVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : release(),
    arch: process.arch,
    syncPending: backlog.pending,
    syncOldestPendingAt: backlog.oldestPendingAt === null ? null : new Date(backlog.oldestPendingAt).toISOString(),
    syncLastError: backlog.lastError,
    syncParked: backlog.parked,
    // Why a Windows machine is stuck on an old version: a Program Files
    // install cannot update itself, and the last updater failure says the rest.
    ...getUpdateDiagnostics(),
    // Screenshots that are not leaving the machine, or not being kept at all.
    ...getScreenshotDiagnostics(),
  };
}

/**
 * One liveness report. It never waits on the sync drain: the server renews the
 * lease from this alone, so a slow backlog can no longer let a running timer's
 * lease lapse. The drain is kicked afterwards and runs on its own.
 */
async function tick(): Promise<void> {
  try {
    const timerService = getTimerService();
    // Read before this tick writes a fresh one: a server close for silence is
    // only overridden for time this process can prove it was alive for.
    const provenAliveAt = timerService.lastLiveness();
    // Before reporting anything: if this beat is the first thing to run after
    // a sleep nobody announced, the entry is closed at the last tick here and
    // the beat reports it stopped rather than vouching for the gap.
    timerService.noteAlive({ persist: true });
    const timerStatus = timerService.status();
    const body = buildHeartbeatRequest({
      agentVersion: agentVersion(),
      platform: currentPlatform(),
      timerStatus,
      observedAt: serverAlignedNow(),
      permissions: await currentPermissionSnapshot(),
      startup: currentStartupSnapshot(),
      diagnostics: currentDiagnostics(),
    });
    // eslint-disable-next-line no-restricted-syntax -- device<->device: RTT halves, and this is what teaches the server clock its offset
    const requestStartedAt = Date.now();
    const res = await api<HeartbeatResponse>('/v1/agent/heartbeat', { method: 'POST', body, timeoutMs: 15_000 });
    // Keep the timer's clock in the server's frame. Without this, a laptop more
    // than the server's 2-minute skew tolerance fast has every uploaded
    // timestamp clamped — and clamped segments whose start and end collapse
    // together are dropped, silently losing tracked time on every sync.
    const previousOffset = serverClockOffsetMs();
    // eslint-disable-next-line no-restricted-syntax -- device<->device: paired with requestStartedAt above to measure round trip
    const offset = noteServerTime(res.serverTime, requestStartedAt, Date.now());
    if (offset !== null && Math.abs(offset - previousOffset) >= 1_000) {
      log.info('server clock offset updated', {
        offsetMs: Math.round(offset),
        previousOffsetMs: Math.round(previousOffset),
        deviceAheadBySec: Math.round(-offset / 1000),
        // True when a timer is open: the correction is held until it stops so
        // the entry cannot straddle two clock frames. Worth seeing in logs —
        // a correction stuck pending across a whole day means the tick that
        // reports tracking state has stopped running.
        correctionHeldForRunningTimer: hasDeferredServerClockCorrection(),
      });
    }
    log.debug('heartbeat ok', { serverTime: res.serverTime, configVersion: res.configVersion });
    // The server answered: a sync pause taken for "no response" is over.
    timerService.noteServerReachable();
    const checkpoint = res.timer;
    const closedForSilence = isClosedForSilence(checkpoint?.closeReason);
    if (checkpoint?.disposition === 'needs_sync' || (checkpoint?.disposition === 'finalized' && closedForSilence)) {
      // Missing, behind, or closed because the server stopped hearing from us:
      // local is the truth, so send it rather than giving up the time.
      await timerService.resyncFromServer(checkpoint.entryId, checkpoint.serverRevision, {
        serverEndedAt: checkpoint.endedAt ? new Date(checkpoint.endedAt).getTime() : null,
        provenAliveAt,
      });
      broadcast('timer:status:push', timerService.status());
    } else if ((checkpoint?.disposition === 'finalized' || checkpoint?.disposition === 'conflict') && checkpoint.endedAt) {
      // Another live timer owns this user (a second device), or the entry was
      // already closed on purpose: stop visibly at the server's boundary.
      log.warn('server rejected active timer checkpoint', {
        entryId: checkpoint.entryId,
        disposition: checkpoint.disposition,
        endedAt: checkpoint.endedAt,
        closeReason: checkpoint.closeReason,
      });
      const status = timerService.acceptServerFinalization(checkpoint.entryId, new Date(checkpoint.endedAt).getTime());
      broadcast('timer:status:push', status);
    }
    requestAgentConfigRefresh(res.configVersion);
    requestTimerDrain('heartbeat');
    requestActivityDrain('heartbeat');
    // Developer commands (and any result still owed) run in the background,
    // one at a time; the heartbeat never waits on them.
    handleRemoteCommands(res.commands);
  } catch (err: unknown) {
    // Keep ticking through every failure, including a token read that failed
    // once. A real sign-out stops the heartbeat through the auth listener.
    log.warn('heartbeat failed', { err: String(err) });
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
