import { z } from 'zod';
import { isYmd, TimeZoneSchema } from './timezone';

/**
 * Developer-triggered commands for one person's desktop agent.
 *
 * The developer creates a command; the agent picks it up on its next heartbeat
 * (`HeartbeatResponse.commands`), runs it silently and posts the outcome to
 * `/v1/agent/commands/:id/result`. v1 knows one command: RESYNC — re-send the
 * laptop's local time, activity and screenshots for a date range.
 */

export const AgentCommandType = z.enum(['RESYNC']);
export type AgentCommandType = z.infer<typeof AgentCommandType>;

export const AgentCommandStatus = z.enum(['PENDING', 'DELIVERED', 'DONE', 'FAILED', 'EXPIRED']);
export type AgentCommandStatus = z.infer<typeof AgentCommandStatus>;

/** Longest RESYNC range, in calendar days (inclusive). */
export const RESYNC_MAX_DAYS = 31;

const DateKey = z.string().refine(isYmd, 'must be a real YYYY-MM-DD date');

/** RESYNC params: calendar dates on the workspace calendar, both inclusive. */
export const ResyncCommandParams = z.object({
  from: DateKey,
  to: DateKey,
  /** The workspace timezone when the command was created; the agent's own wins. */
  timeZone: TimeZoneSchema.optional(),
});
export type ResyncCommandParams = z.infer<typeof ResyncCommandParams>;

/**
 * A command as the heartbeat hands it to the agent. `type` is a plain string
 * so a newer server can add a type without an older agent failing to read the
 * whole list; the agent answers an unknown type with FAILED.
 */
export const AgentCommandWire = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  params: z.record(z.unknown()),
});
export type AgentCommandWire = z.infer<typeof AgentCommandWire>;

/** POST /v1/dev/agent-commands — target by id or by email. */
export const CreateAgentCommandRequest = z
  .object({
    userId: z.string().min(1).optional(),
    email: z.string().email().optional(),
    type: z.literal('RESYNC'),
    from: DateKey,
    to: DateKey,
  })
  .refine((body) => Boolean(body.userId) !== Boolean(body.email), {
    message: 'give exactly one of userId or email',
    path: ['userId'],
  });
export type CreateAgentCommandRequest = z.infer<typeof CreateAgentCommandRequest>;

export const ListAgentCommandsQuery = z.object({
  userId: z.string().min(1).optional(),
});
export type ListAgentCommandsQuery = z.infer<typeof ListAgentCommandsQuery>;

/** POST /v1/agent/commands/:id/result — the agent's outcome. */
export const AgentCommandResultRequest = z.object({
  status: z.enum(['DONE', 'FAILED']),
  result: z.record(z.unknown()).optional(),
  error: z.string().max(2_000).optional(),
});
export type AgentCommandResultRequest = z.infer<typeof AgentCommandResultRequest>;

/** What a RESYNC run reports back (the `result` of a DONE/FAILED command). */
export interface ResyncCommandResult {
  range: { from: string; to: string; timeZone: string; startAt: string; endAt: string };
  timer: {
    /** Entries put back on the upload queue (closed entries with a bumped revision). */
    requeued: number;
    /** Whether the running entry was queued again too. */
    openRequeued: boolean;
    /** Crash-recovered entries left alone: their local end is an estimate the server may beat. */
    skippedRecovered?: number;
    /** Closed entries in the range still not acknowledged by the server. */
    pendingAfter: number;
    lastErrors: string[];
  };
  activity: { requeued: number; pendingAfter: number };
  screenshots: { requeued: number; uploaded: number; failed: number; pendingAfter: number };
  appVersion: string;
  os: string;
  arch: string;
  durationMs: number;
  /** True when the 2-minute wait ended with data still queued (it keeps syncing). */
  timedOut: boolean;
}

export interface AgentCommandPerson {
  id: string;
  name: string;
  email: string;
}

/** A command as the developer page lists it. */
export interface AgentCommandDto {
  id: string;
  type: AgentCommandType;
  status: AgentCommandStatus;
  params: Record<string, unknown>;
  createdAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  user: AgentCommandPerson;
  requestedBy: Pick<AgentCommandPerson, 'id' | 'name'>;
}

/** A person the developer page can target, with what their agent last said. */
export interface AgentCommandTargetDto extends AgentCommandPerson {
  agentVersion: string | null;
  agentPlatform: string | null;
  agentLastSeenAt: string | null;
}
