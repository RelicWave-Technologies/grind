import { z } from 'zod';
import {
  DEFAULT_SCREENSHOT_INTERVAL_MIN,
  ScreenshotIntervalMinSchema,
} from './teamSettings';
import { TimeZoneSchema } from './timezone';

export const AgentState = z.enum(['IDLE', 'RUNNING', 'PAUSED_IDLE', 'PAUSED_PERMISSION', 'OFFLINE']);
export type AgentState = z.infer<typeof AgentState>;

export const TIMER_TRACKING_PROTOCOL_VERSION = 2 as const;

export const TimerCheckpoint = z.object({
  entryId: z.string().min(1),
  revision: z.number().int().min(1),
  state: z.enum(['RUNNING', 'PAUSED_IDLE', 'PAUSED_PERMISSION']),
  observedAt: z.string().datetime({ offset: true }),
});
export type TimerCheckpoint = z.infer<typeof TimerCheckpoint>;

export const TimerCheckpointDisposition = z.enum([
  'accepted',
  'needs_sync',
  'finalized',
  'conflict',
]);
export type TimerCheckpointDisposition = z.infer<typeof TimerCheckpointDisposition>;

export const Platform = z.enum(['darwin', 'win32', 'linux']);
export type Platform = z.infer<typeof Platform>;

export const ScreenPermissionStatus = z.enum(['granted', 'denied', 'restricted', 'not-determined', 'unknown']);
export type ScreenPermissionStatus = z.infer<typeof ScreenPermissionStatus>;

export const CaptureHealth = z.enum(['ok', 'no-permission', 'empty', 'error', 'unknown']);
export type CaptureHealth = z.infer<typeof CaptureHealth>;

export const ScreenPermissionState = z.enum(['ok', 'needs-grant', 'needs-settings', 'needs-restart']);
export type ScreenPermissionState = z.infer<typeof ScreenPermissionState>;

export const DesktopPermissionSnapshot = z.object({
  screen: z.object({
    status: ScreenPermissionStatus,
    health: CaptureHealth,
    state: ScreenPermissionState,
  }),
  accessibility: z.object({
    trusted: z.boolean(),
    ready: z.boolean(),
    recording: z.boolean(),
    capturing: z.boolean(),
    hookRunning: z.boolean(),
  }),
});
export type DesktopPermissionSnapshot = z.infer<typeof DesktopPermissionSnapshot>;

export const LaunchAtLoginState = z.enum([
  'READY',
  'NEEDS_INSTALL',
  'NEEDS_REGISTRATION',
  'NEEDS_APPROVAL',
  'NEEDS_REPAIR',
  'BLOCKED',
  'UNAVAILABLE',
]);
export type LaunchAtLoginState = z.infer<typeof LaunchAtLoginState>;

export const LaunchOrigin = z.enum(['LOGIN_ITEM', 'USER', 'UNKNOWN']);
export type LaunchOrigin = z.infer<typeof LaunchOrigin>;

export const LaunchAtLoginSnapshot = z.object({
  state: LaunchAtLoginState,
  ready: z.boolean(),
  openedAtLogin: z.boolean(),
  origin: LaunchOrigin,
}).superRefine((value, ctx) => {
  if (value.ready !== (value.state === 'READY')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ready'],
      message: 'ready must match the READY state',
    });
  }
});
export type LaunchAtLoginSnapshot = z.infer<typeof LaunchAtLoginSnapshot>;

export const HeartbeatRequest = z.object({
  agentVersion: z.string(),
  platform: Platform,
  state: AgentState.default('IDLE'),
  activeEntryId: z.string().min(1).nullable().optional(),
  trackingProtocolVersion: z.literal(TIMER_TRACKING_PROTOCOL_VERSION).optional(),
  timerCheckpoint: TimerCheckpoint.nullable().optional(),
  permissions: DesktopPermissionSnapshot.optional(),
  startup: LaunchAtLoginSnapshot.optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  ok: z.literal(true),
  serverTime: z.string(),
  configVersion: z.string().min(1).default('legacy'),
  timer: z.object({
    disposition: TimerCheckpointDisposition,
    entryId: z.string(),
    serverRevision: z.number().int().min(0).nullable(),
    endedAt: z.string().nullable(),
    closeReason: z.enum(['AGENT', 'AGENT_RECOVERY', 'LEASE_EXPIRED', 'SUPERSEDED', 'LEGACY_RECONCILED']).nullable(),
  }).nullable().optional(),
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

export const TodayLedgerMode = z.enum(['OFF', 'SHADOW', 'VISIBLE']);
export type TodayLedgerMode = z.infer<typeof TodayLedgerMode>;

export const AgentConfigResponse = z.object({
  configVersion: z.string().default(''),
  heartbeatIntervalSec: z.number().int().min(15).max(600).default(60),
  screenshotIntervalMin: ScreenshotIntervalMinSchema.default(DEFAULT_SCREENSHOT_INTERVAL_MIN),
  idleThresholdMin: z.number().int().min(1).max(120).default(5),
  captureApps: z.boolean().default(false),
  captureTitles: z.boolean().default(false),
  captureUrls: z.boolean().default(false),
  todayLedgerMode: TodayLedgerMode.default('OFF'),
  // Web dashboard origin, served so the agent's "Open Dashboard" button stays in
  // sync with the backend's DASHBOARD_URL (empty string when unset).
  dashboardUrl: z.string().default(''),
  workspaceTimezone: TimeZoneSchema.default('UTC'),
});
export type AgentConfigResponse = z.infer<typeof AgentConfigResponse>;
