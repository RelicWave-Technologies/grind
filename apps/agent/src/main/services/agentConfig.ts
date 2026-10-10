import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AgentConfigResponse as AgentConfigResponseSchema,
  type AgentConfigResponse as AgentConfigResponseType,
  type PolicyFlags,
  type TodayLedgerMode,
} from '@grind/types';
import { api } from './apiClient';
import { SCREENSHOT_INTERVAL_SEC, IDLE_THRESHOLD_SEC, SHOT_SEC_LOCKED, IDLE_SEC_LOCKED } from '../env';
import { log } from '../logger';
import {
  applyServerWorkspaceTimeZone,
} from './workspaceTime';
import { loadTokens, type StoredTokens } from './tokenStore';

export type CapturePolicy = PolicyFlags;

interface RuntimeAgentConfig {
  configVersion: string | null;
  screenshotIntervalSec: number;
  idleThresholdSec: number;
  idleWarningSeconds: number | null;
  captureApps: boolean;
  captureTitles: boolean;
  captureUrls: boolean;
  todayLedgerMode: TodayLedgerMode;
  dashboardUrl: string;
  workspaceTimezone: string;
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
let idleWarningSeconds: number | null = null;
let dashboardUrl = '';
let workspaceTimezone = 'UTC';
let configVersion: string | null = null;
let captureApps = false;
let captureTitles = false;
let captureUrls = false;
let todayLedgerMode: TodayLedgerMode = 'OFF';
let refreshInFlight: { sessionKey: string; promise: Promise<void> } | null = null;
let hasAppliedConfig = false;
const listeners = new Set<(change: AgentConfigChange) => void>();

export function getScreenshotIntervalSec(): number {
  return screenshotIntervalSec;
}
export function getIdleThresholdSec(): number {
  return idleThresholdSec;
}
export function getIdleWarningSeconds(): number | null {
  return idleWarningSeconds;
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

export function getTodayLedgerMode(): TodayLedgerMode {
  return todayLedgerMode;
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
    idleWarningSeconds,
    captureApps,
    captureTitles,
    captureUrls,
    todayLedgerMode,
    dashboardUrl,
    workspaceTimezone,
  };
}

function sameConfig(a: RuntimeAgentConfig | null, b: RuntimeAgentConfig): boolean {
  return Boolean(
    a &&
      a.configVersion === b.configVersion &&
      a.screenshotIntervalSec === b.screenshotIntervalSec &&
      a.idleThresholdSec === b.idleThresholdSec &&
      a.idleWarningSeconds === b.idleWarningSeconds &&
      a.captureApps === b.captureApps &&
      a.captureTitles === b.captureTitles &&
      a.captureUrls === b.captureUrls &&
      a.todayLedgerMode === b.todayLedgerMode &&
      a.dashboardUrl === b.dashboardUrl &&
      a.workspaceTimezone === b.workspaceTimezone,
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

function sameSession(a: Pick<StoredTokens, 'userId' | 'workspaceId'> | null, b: Pick<StoredTokens, 'userId' | 'workspaceId'>): boolean {
  return Boolean(a && a.userId === b.userId && a.workspaceId === b.workspaceId);
}

/**
 * The last config this session's server sent, on disk, so an offline boot
 * keeps the real idle threshold, screenshot interval and ledger mode instead
 * of the build's defaults. Scoped to user + workspace: a shared machine never
 * applies one account's policy to another.
 */
interface CachedAgentConfig {
  userId: string;
  workspaceId: string;
  config: unknown;
}

function configCachePath(): string {
  return path.join(app.getPath('userData'), 'agent-config.json');
}

async function writeConfigCache(session: StoredTokens, config: AgentConfigResponseType): Promise<void> {
  const target = configCachePath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    const cached: CachedAgentConfig = { userId: session.userId, workspaceId: session.workspaceId, config };
    await fs.writeFile(tmp, JSON.stringify(cached), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    void fs.unlink(tmp).catch(() => undefined);
    log.warn('agent config cache write failed', { err: String(err) });
  }
}

async function readConfigCache(session: StoredTokens): Promise<AgentConfigResponseType | null> {
  try {
    const cached = JSON.parse(await fs.readFile(configCachePath(), 'utf8')) as Partial<CachedAgentConfig>;
    if (cached.userId !== session.userId || cached.workspaceId !== session.workspaceId) return null;
    const parsed = AgentConfigResponseSchema.safeParse(cached.config);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('agent config cache unreadable', { err: String(err) });
    return null;
  }
}

async function applyAgentConfig(cfg: AgentConfigResponseType, requestedSession: StoredTokens): Promise<void> {
  const nextWorkspaceTimezone = cfg.workspaceTimezone || 'UTC';
  await applyServerWorkspaceTimeZone(nextWorkspaceTimezone, requestedSession.workspaceId);
  if (!sameSession(await loadTokens(), requestedSession)) {
    throw new Error('agent_config_session_changed');
  }
  applyConfigValues(cfg);
}

/**
 * Before the network: the cached config, so the boot-to-online window (or an
 * offline day) runs on this account's real policy. The business day is not
 * touched — workspace time restores its own cache.
 */
async function applyCachedAgentConfig(session: StoredTokens): Promise<void> {
  if (hasAppliedConfig) return;
  const cached = await readConfigCache(session);
  if (!cached || hasAppliedConfig || !sameSession(await loadTokens(), session)) return;
  applyConfigValues(cached);
  log.info('agent config restored from cache', { configVersion });
}

function applyConfigValues(cfg: AgentConfigResponseType): void {
  const nextWorkspaceTimezone = cfg.workspaceTimezone || 'UTC';
  const previous = hasAppliedConfig ? snapshot() : null;
  configVersion = cfg.configVersion || null;
  if (!SHOT_SEC_LOCKED) screenshotIntervalSec = Math.max(60, cfg.screenshotIntervalMin * 60);
  if (!IDLE_SEC_LOCKED) idleThresholdSec = Math.max(60, cfg.idleThresholdMin * 60);
  idleWarningSeconds =
    cfg.idleWarningSeconds != null && cfg.idleWarningSeconds < idleThresholdSec
      ? cfg.idleWarningSeconds
      : null;
  dashboardUrl = cfg.dashboardUrl ?? '';
  workspaceTimezone = nextWorkspaceTimezone;
  captureApps = Boolean(cfg.captureApps);
  captureTitles = captureApps && Boolean(cfg.captureTitles);
  captureUrls = captureApps && Boolean(cfg.captureUrls);
  todayLedgerMode = cfg.todayLedgerMode;
  const current = snapshot();
  hasAppliedConfig = true;
  notifyConfigChange(previous, current);
}

/** Fetch the effective capture config from the API and apply it. No-ops on
 *  failure (keeps the current/boot value). Safe to call when logged out — the
 *  authed request throws and we keep defaults. */
export async function refreshAgentConfig(): Promise<void> {
  const requestedSession = await loadTokens();
  if (!requestedSession) return;
  const sessionKey = `${requestedSession.userId}:${requestedSession.workspaceId}`;

  if (refreshInFlight) {
    if (refreshInFlight.sessionKey === sessionKey) return refreshInFlight.promise;
    await refreshInFlight.promise;
    return refreshAgentConfig();
  }

  const promise = refreshAgentConfigOnce(requestedSession).finally(() => {
    if (refreshInFlight?.promise === promise) refreshInFlight = null;
  });
  refreshInFlight = { sessionKey, promise };
  return promise;
}

async function refreshAgentConfigOnce(requestedSession: StoredTokens): Promise<void> {
  await applyCachedAgentConfig(requestedSession);
  try {
    const raw = await api<unknown>('/v1/agent/config');
    const currentSession = await loadTokens();
    if (
      !currentSession
      || currentSession.userId !== requestedSession.userId
      || currentSession.workspaceId !== requestedSession.workspaceId
    ) {
      log.info('agent config response discarded because the stored session changed');
      return;
    }
    const parsed = AgentConfigResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn('agent config response invalid - keeping privacy-first defaults', { issues: parsed.error.flatten() });
      return;
    }
    await applyAgentConfig(parsed.data, requestedSession);
    await writeConfigCache(requestedSession, parsed.data);
    log.info('agent config applied', {
      configVersion,
      screenshotIntervalSec,
      idleThresholdSec,
      idleWarningSeconds,
      captureApps,
      captureTitles,
      captureUrls,
      todayLedgerMode,
      workspaceTimezone,
      shotLocked: SHOT_SEC_LOCKED,
      idleLocked: IDLE_SEC_LOCKED,
    });
  } catch (err) {
    log.warn('agent config fetch failed — keeping current values', { err: String(err) });
  }
}
