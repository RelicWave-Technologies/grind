import type { HeartbeatRequest, HeartbeatResponse, Platform } from '@grind/types';
import { AGENT_VERSION, HEARTBEAT_INTERVAL_MS } from '../env';
import { log } from '../logger';
import { api, UnauthorizedError } from './apiClient';
import { isLoggedIn } from './auth';

let timer: NodeJS.Timeout | null = null;
let lastHeartbeatAt: string | null = null;

function platform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

async function tick(): Promise<void> {
  const body: HeartbeatRequest = {
    agentVersion: AGENT_VERSION,
    platform: platform(),
    state: 'IDLE',
  };
  try {
    const res = await api<HeartbeatResponse>('/v1/agent/heartbeat', { method: 'POST', body });
    lastHeartbeatAt = res.serverTime;
    log.debug('heartbeat ok', { serverTime: res.serverTime });
  } catch (err: unknown) {
    if (err instanceof UnauthorizedError) {
      log.warn('heartbeat unauthorized; stopping');
      stopHeartbeat();
    } else {
      log.warn('heartbeat failed', { err: String(err) });
    }
  }
}

export function startHeartbeat(): void {
  if (timer) return;
  void tick();
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
