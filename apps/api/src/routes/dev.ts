import { Router, type RequestHandler } from 'express';
import { prisma } from '@grind/db';
import {
  CreateAgentCommandRequest,
  ListAgentCommandsQuery,
  RESYNC_MAX_DAYS,
  daysBetween,
  type AgentCommandTargetDto,
} from '@grind/types';
import { requireAccessToken } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { developerEmails, isDeveloperEmail } from '../env';
import { createResyncCommand, getAgentCommand, listAgentCommands } from '../agent/commands';

/**
 * Hidden developer tools. Only callers whose email is in DEVELOPER_EMAILS get
 * past the gate; everyone else — admins included — gets the same 404 as a
 * route that does not exist, so the tools are not advertised. With the
 * allowlist empty the whole router is off.
 */
export const devRouter = Router();

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'not_found' });
};

const featureEnabled: RequestHandler = (req, res, next) => {
  if (developerEmails().length === 0) return notFound(req, res, next);
  next();
};

const requireDeveloper: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) return notFound(req, res, next);
    const caller = await prisma.user.findFirst({
      where: { id: req.user.sub, workspaceId: req.user.ws, deactivatedAt: null },
      select: { email: true },
    });
    if (!caller || !isDeveloperEmail(caller.email)) return notFound(req, res, next);
    next();
  } catch (err) {
    next(err);
  }
};

devRouter.use(featureEnabled, requireAccessToken, requireDeveloper);

/** Everyone in the workspace a command can target, with their agent's last report. */
devRouter.get('/people', async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { workspaceId: req.user!.ws, deactivatedAt: null, provisioningStatus: 'ACTIVE' },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        agentVersion: true,
        agentPlatform: true,
        agentLastSeenAt: true,
      },
    });
    const people: AgentCommandTargetDto[] = users.map((u) => ({
      ...u,
      agentLastSeenAt: u.agentLastSeenAt?.toISOString() ?? null,
    }));
    res.json({ people });
  } catch (err) {
    next(err);
  }
});

devRouter.post('/agent-commands', validate(CreateAgentCommandRequest, 'body'), async (req, res, next) => {
  try {
    const body = req.body as CreateAgentCommandRequest;
    if (body.from > body.to) return res.status(400).json({ error: 'invalid_range' });
    if (daysBetween(body.from, body.to) + 1 > RESYNC_MAX_DAYS) {
      return res.status(400).json({ error: 'range_too_long', maxDays: RESYNC_MAX_DAYS });
    }
    const target = await prisma.user.findFirst({
      where: {
        workspaceId: req.user!.ws,
        deactivatedAt: null,
        ...(body.userId
          ? { id: body.userId }
          : { email: { equals: body.email!.trim(), mode: 'insensitive' as const } }),
      },
      select: { id: true, workspace: { select: { timezone: true } } },
    });
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    const command = await createResyncCommand({
      workspaceId: req.user!.ws,
      userId: target.id,
      requestedById: req.user!.sub,
      params: { from: body.from, to: body.to, timeZone: target.workspace.timezone },
    });
    req.log?.info({ commandId: command.id, targetUserId: target.id, from: body.from, to: body.to }, 'agent resync requested');
    res.status(201).json(command);
  } catch (err) {
    next(err);
  }
});

devRouter.get('/agent-commands', validate(ListAgentCommandsQuery, 'query'), async (req, res, next) => {
  try {
    const query = req.query as unknown as ListAgentCommandsQuery;
    res.json({ commands: await listAgentCommands(req.user!.ws, query.userId) });
  } catch (err) {
    next(err);
  }
});

devRouter.get('/agent-commands/:id', async (req, res, next) => {
  try {
    const command = await getAgentCommand(req.user!.ws, req.params.id!);
    if (!command) return res.status(404).json({ error: 'not_found' });
    res.json(command);
  } catch (err) {
    next(err);
  }
});
