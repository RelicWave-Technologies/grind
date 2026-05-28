import { Router } from 'express';
import { AgentConfigResponse, HeartbeatRequest, HeartbeatResponse } from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';

export const agentRouter = Router();

agentRouter.use(requireAccessToken);

agentRouter.post('/heartbeat', validate(HeartbeatRequest, 'body'), (_req, res) => {
  const response: HeartbeatResponse = { ok: true, serverTime: new Date().toISOString() };
  res.json(response);
});

agentRouter.get('/config', (_req, res) => {
  const response: AgentConfigResponse = { heartbeatIntervalSec: 60 };
  res.json(response);
});
