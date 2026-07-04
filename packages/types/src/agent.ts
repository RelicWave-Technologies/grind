import { z } from 'zod';
import {
  DEFAULT_SCREENSHOT_INTERVAL_MIN,
  ScreenshotIntervalMinSchema,
} from './teamSettings';

export const AgentState = z.enum(['IDLE', 'RUNNING', 'PAUSED_IDLE', 'OFFLINE']);
export type AgentState = z.infer<typeof AgentState>;

export const Platform = z.enum(['darwin', 'win32', 'linux']);
export type Platform = z.infer<typeof Platform>;

export const HeartbeatRequest = z.object({
  agentVersion: z.string(),
  platform: Platform,
  state: AgentState.default('IDLE'),
  activeEntryId: z.string().min(1).nullable().optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  ok: z.literal(true),
  serverTime: z.string(),
  configVersion: z.string().min(1).default('legacy'),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** One extracted app icon the agent uploads (PNG, base64). */
export const AgentAppIconItem = z.object({
  bundleId: z.string().min(1).max(255),
  app: z.string().min(1).max(255),
  pngBase64: z.string().min(1).max(200_000),
});
export type AgentAppIconItem = z.infer<typeof AgentAppIconItem>;

export const AgentAppIconsRequest = z.object({
  icons: z.array(AgentAppIconItem).min(1).max(50),
});
export type AgentAppIconsRequest = z.infer<typeof AgentAppIconsRequest>;

export const AgentConfigResponse = z.object({
  configVersion: z.string().default(''),
  heartbeatIntervalSec: z.number().int().min(15).max(600).default(60),
  screenshotIntervalMin: ScreenshotIntervalMinSchema.default(DEFAULT_SCREENSHOT_INTERVAL_MIN),
  idleThresholdMin: z.number().int().min(1).max(120).default(5),
  captureApps: z.boolean().default(false),
  captureTitles: z.boolean().default(false),
  captureUrls: z.boolean().default(false),
  // Web dashboard origin, served so the agent's "Open Dashboard" button stays in
  // sync with the backend's DASHBOARD_URL (empty string when unset).
  dashboardUrl: z.string().default(''),
});
export type AgentConfigResponse = z.infer<typeof AgentConfigResponse>;
