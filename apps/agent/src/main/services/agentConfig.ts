import {
  AgentConfigResponse as AgentConfigResponseSchema,
  type AgentConfigResponse as AgentConfigResponseType,
  type PolicyFlags,
} from '@grind/types';
import { api } from './apiClient';
import { SCREENSHOT_INTERVAL_SEC, IDLE_THRESHOLD_SEC, SHOT_SEC_LOCKED, IDLE_SEC_LOCKED } from '../env';
import { log } from '../logger';

export type CapturePolicy = PolicyFlags;

export interface RuntimeAgentConfig {
  configVersion: string | null;
  screenshotIntervalSec: number;
  idleThresholdSec: number;
  captureApps: boolean;
  captureTitles: boolean;
  captureUrls: boolean;
  dashboardUrl: string;
}

export interface AgentConfigChange {
  previous: RuntimeAgentConfig | null;
  current: RuntimeAgentConfig;
}

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
let configVersion: string | null = null;
let captureApps = false;
let captureTitles = false;
let captureUrls = false;
let refreshInFlight: Promise<void> | null = null;
let hasAppliedConfig = false;
const listeners = new Set<(change: AgentConfigChange) => void>();

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

export function getAgentConfigVersion(): string | null {
  return configVersion;
}

export function getCapturePolicy(): CapturePolicy {
  return { captureApps, captureTitles, captureUrls };
}

export function onAgentConfigChange(listener: (change: AgentConfigChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): RuntimeAgentConfig {
  return {
    configVersion,
    screenshotIntervalSec,
    idleThresholdSec,
    captureApps,
    captureTitles,
    captureUrls,
    dashboardUrl,
  };
}

function sameConfig(a: RuntimeAgentConfig | null, b: RuntimeAgentConfig): boolean {
  return Boolean(
    a &&
      a.configVersion === b.configVersion &&
      a.screenshotIntervalSec === b.screenshotIntervalSec &&
      a.idleThresholdSec === b.idleThresholdSec &&
      a.captureApps === b.captureApps &&
      a.captureTitles === b.captureTitles &&
      a.captureUrls === b.captureUrls &&
      a.dashboardUrl === b.dashboardUrl,
  );
}

function notifyConfigChange(previous: RuntimeAgentConfig | null, current: RuntimeAgentConfig): void {
  if (sameConfig(previous, current)) return;
  for (const listener of listeners) {
    try {
      listener({ previous, current });
    } catch (err) {
      log.warn('agent config listener failed', { err: String(err) });
    }
  }
}

function applyAgentConfig(cfg: AgentConfigResponseType): void {
  const previous = hasAppliedConfig ? snapshot() : null;
  configVersion = cfg.configVersion || null;
  if (!SHOT_SEC_LOCKED) screenshotIntervalSec = Math.max(60, cfg.screenshotIntervalMin * 60);
  if (!IDLE_SEC_LOCKED) idleThresholdSec = Math.max(60, cfg.idleThresholdMin * 60);
  dashboardUrl = cfg.dashboardUrl ?? '';
  captureApps = Boolean(cfg.captureApps);
  captureTitles = captureApps && Boolean(cfg.captureTitles);
  captureUrls = captureApps && Boolean(cfg.captureUrls);
  const current = snapshot();
  hasAppliedConfig = true;
  notifyConfigChange(previous, current);
}

/** Fetch the effective capture config from the API and apply it. No-ops on
 *  failure (keeps the current/boot value). Safe to call when logged out — the
 *  authed request throws and we keep defaults. */
export async function refreshAgentConfig(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshAgentConfigOnce().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshAgentConfigOnce(): Promise<void> {
  try {
    const raw = await api<unknown>('/v1/agent/config');
    const parsed = AgentConfigResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn('agent config response invalid - keeping privacy-first defaults', { issues: parsed.error.flatten() });
      return;
    }
    applyAgentConfig(parsed.data);
    log.info('agent config applied', {
      configVersion,
      screenshotIntervalSec,
      idleThresholdSec,
      captureApps,
      captureTitles,
      captureUrls,
      shotLocked: SHOT_SEC_LOCKED,
      idleLocked: IDLE_SEC_LOCKED,
    });
  } catch (err) {
    log.warn('agent config fetch failed — keeping current values', { err: String(err) });
  }
}
