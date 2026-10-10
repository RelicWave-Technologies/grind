import { prisma, type Prisma } from '@grind/db';
import type {
  AgentCommandDto,
  AgentCommandResultRequest,
  AgentCommandStatus,
  AgentCommandWire,
} from '@grind/types';

/**
 * Developer-triggered commands for a person's desktop agent.
 *
 * Delivery piggybacks on the heartbeat the agent already sends every minute:
 * the response carries this user's PENDING commands, which become DELIVERED.
 * A DELIVERED command with no result after {@link REDELIVER_AFTER_MS} is
 * handed out again (the agent may have restarted before it reported). The
 * agent remembers what it ran, so a re-delivery never runs it twice — it only
 * re-posts the result.
 */

const REDELIVER_AFTER_MS = 10 * 60_000;
/** Per heartbeat; the agent runs them one at a time anyway. */
const MAX_DELIVERED_PER_HEARTBEAT = 5;

const COMMAND_INCLUDE = {
  user: { select: { id: true, name: true, email: true } },
  requestedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.AgentCommandInclude;

type CommandRow = Prisma.AgentCommandGetPayload<{ include: typeof COMMAND_INCLUDE }>;

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function serializeAgentCommand(row: CommandRow): AgentCommandDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    params: asRecord(row.params) ?? {},
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    result: asRecord(row.result),
    error: row.error,
    user: row.user,
    requestedBy: row.requestedBy,
  };
}

export async function createResyncCommand(args: {
  workspaceId: string;
  userId: string;
  requestedById: string;
  params: { from: string; to: string; timeZone: string };
}): Promise<AgentCommandDto> {
  const row = await prisma.agentCommand.create({
    data: {
      workspaceId: args.workspaceId,
      userId: args.userId,
      requestedById: args.requestedById,
      type: 'RESYNC',
      params: args.params,
    },
    include: COMMAND_INCLUDE,
  });
  return serializeAgentCommand(row);
}

export async function listAgentCommands(workspaceId: string, userId?: string): Promise<AgentCommandDto[]> {
  const rows = await prisma.agentCommand.findMany({
    where: { workspaceId, ...(userId ? { userId } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
    include: COMMAND_INCLUDE,
  });
  return rows.map(serializeAgentCommand);
}

export async function getAgentCommand(workspaceId: string, id: string): Promise<AgentCommandDto | null> {
  const row = await prisma.agentCommand.findFirst({ where: { id, workspaceId }, include: COMMAND_INCLUDE });
  return row ? serializeAgentCommand(row) : null;
}

/**
 * The commands this heartbeat should carry, marked DELIVERED. Oldest first.
 * Re-delivered commands get a fresh deliveredAt, so the next re-delivery is
 * another ten minutes away rather than every tick.
 */
export async function deliverAgentCommands(userId: string, now: Date): Promise<AgentCommandWire[]> {
  const rows = await prisma.agentCommand.findMany({
    where: {
      userId,
      OR: [
        { status: 'PENDING' },
        { status: 'DELIVERED', deliveredAt: { lt: new Date(now.getTime() - REDELIVER_AFTER_MS) } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_DELIVERED_PER_HEARTBEAT,
    select: { id: true, type: true, params: true },
  });
  if (rows.length === 0) return [];
  await prisma.agentCommand.updateMany({
    where: { id: { in: rows.map((row) => row.id) }, status: { in: ['PENDING', 'DELIVERED'] } },
    data: { status: 'DELIVERED', deliveredAt: now },
  });
  return rows.map((row) => ({ id: row.id, type: row.type, params: asRecord(row.params) ?? {} }));
}

export type RecordResultOutcome =
  | { kind: 'not_found' }
  | { kind: 'recorded' | 'already_completed'; status: AgentCommandStatus };

/**
 * Store the agent's outcome. Only the command's own target can report it.
 * Idempotent: the first DONE/FAILED wins and a repeat is answered as success,
 * so an agent that lost the response can safely post again. A late result for
 * a command the prune already expired is still recorded — it is what happened.
 */
export async function recordAgentCommandResult(args: {
  id: string;
  userId: string;
  workspaceId: string;
  body: AgentCommandResultRequest;
  now: Date;
}): Promise<RecordResultOutcome> {
  const existing = await prisma.agentCommand.findUnique({
    where: { id: args.id },
    select: { userId: true, workspaceId: true, status: true },
  });
  if (!existing || existing.userId !== args.userId || existing.workspaceId !== args.workspaceId) {
    return { kind: 'not_found' };
  }
  if (existing.status === 'DONE' || existing.status === 'FAILED') {
    return { kind: 'already_completed', status: existing.status };
  }
  const { count } = await prisma.agentCommand.updateMany({
    where: { id: args.id, status: { in: ['PENDING', 'DELIVERED', 'EXPIRED'] } },
    data: {
      status: args.body.status,
      result: (args.body.result ?? undefined) as Prisma.InputJsonValue | undefined,
      error: args.body.error ?? null,
      completedAt: args.now,
    },
  });
  if (count === 0) {
    const raced = await prisma.agentCommand.findUnique({ where: { id: args.id }, select: { status: true } });
    return { kind: 'already_completed', status: raced?.status ?? args.body.status };
  }
  return { kind: 'recorded', status: args.body.status };
}
