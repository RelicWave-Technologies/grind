import { z } from 'zod';

export const AgentState = z.enum(['IDLE', 'RUNNING', 'PAUSED_IDLE', 'OFFLINE']);
export type AgentState = z.infer<typeof AgentState>;

export const Platform = z.enum(['darwin', 'win32', 'linux']);
export type Platform = z.infer<typeof Platform>;

export const HeartbeatRequest = z.object({
  agentVersion: z.string(),
  platform: Platform,
  state: AgentState.default('IDLE'),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  ok: z.literal(true),
  serverTime: z.string(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const AgentConfigResponse = z.object({
  heartbeatIntervalSec: z.number().int().min(15).max(600).default(60),
  screenshotIntervalMin: z.number().int().min(1).max(480).default(180),
  idleThresholdMin: z.number().int().min(1).max(120).default(5),
});
export type AgentConfigResponse = z.infer<typeof AgentConfigResponse>;
