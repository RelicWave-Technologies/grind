import type { AgentConfigResponse } from '@grind/types';
import { api } from './apiClient';
import { SCREENSHOT_INTERVAL_SEC, IDLE_THRESHOLD_SEC, SHOT_SEC_LOCKED, IDLE_SEC_LOCKED } from '../env';
import { log } from '../logger';

/**
 * Runtime capture config, driven by the server (/v1/agent/config), which
 * resolves per-user override → workspace policy default → fallback. The capture
 * loop and idle monitor read the live values via the getters below, so a policy
 * change takes effect on the next scheduled tick after a refresh.
 *
 * Boot/offline defaults come from env; an explicit AGENT_SHOT_SEC / AGENT_IDLE_SEC
 * locks the value (dev/testing) so a server refresh won't override it.
 */
let screenshotIntervalSec = SCREENSHOT_INTERVAL_SEC;
let idleThresholdSec = IDLE_THRESHOLD_SEC;
let dashboardUrl = '';

export function getScreenshotIntervalSec(): number {
  return screenshotIntervalSec;
}
export function getIdleThresholdSec(): number {
  return idleThresholdSec;
}
/** Web dashboard origin from the server config ('' until first successful fetch). */
export function getDashboardUrl(): string {
  return dashboardUrl;
}

/** Fetch the effective capture config from the API and apply it. No-ops on
 *  failure (keeps the current/boot value). Safe to call when logged out — the
 *  authed request throws and we keep defaults. */
export async function refreshAgentConfig(): Promise<void> {
  try {
    const cfg = await api<AgentConfigResponse>('/v1/agent/config');
    if (!SHOT_SEC_LOCKED) screenshotIntervalSec = Math.max(60, cfg.screenshotIntervalMin * 60);
    if (!IDLE_SEC_LOCKED) idleThresholdSec = Math.max(60, cfg.idleThresholdMin * 60);
    if (cfg.dashboardUrl) dashboardUrl = cfg.dashboardUrl;
    log.info('agent config applied', {
      screenshotIntervalSec,
      idleThresholdSec,
      shotLocked: SHOT_SEC_LOCKED,
      idleLocked: IDLE_SEC_LOCKED,
    });
  } catch (err) {
    log.warn('agent config fetch failed — keeping current values', { err: String(err) });
  }
}
