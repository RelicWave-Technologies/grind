import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { logger } from './logger';
import { authRouter } from './routes/auth';
import { agentRouter } from './routes/agent';
import { timeEntriesRouter } from './routes/timeEntries';
import { activityRouter } from './routes/activity';
import { larkRouter } from './routes/lark';
import { insightsRouter } from './routes/insights';
import { timeRequestsRouter } from './routes/timeRequests';
import { adminRouter } from './routes/admin';
import { workspaceRouter } from './routes/workspace';
import { workspacePolicyRouter } from './routes/workspacePolicy';
import { digestsRouter } from './routes/digests';
import { payrollRouter } from './routes/payroll';
import { overviewRouter } from './routes/overview';
import { errorHandler } from './middleware/errorHandler';

export function buildApp() {
  const app = express();

  app.use(helmet());
  // CORS: allow credentials so the dashboard (separate origin in dev: 5174)
  // can ship the grind_at cookie. `origin: true` reflects the request
  // origin, which Express's cors lib pairs with the Access-Control-Allow-
  // Credentials: true header. Production may want a stricter allowlist.
  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '64kb' }));
  app.use(
    pinoHttp({
      logger,
      redact: {
        paths: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken'],
        censor: '[redacted]',
      },
    }),
  );

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/v1/auth', authRouter);
  app.use('/v1/agent', agentRouter);
  app.use('/v1/time-entries', timeEntriesRouter);
  app.use('/v1/activity-samples', activityRouter);
  app.use('/v1/lark', larkRouter);
  app.use('/v1/insights', insightsRouter);
  app.use('/v1/time-requests', timeRequestsRouter);
  app.use('/v1/admin', adminRouter);
  app.use('/v1/workspace', workspaceRouter);
  app.use('/v1/admin/workspace-policy', workspacePolicyRouter);
  app.use('/v1/admin/digests', digestsRouter);
  app.use('/v1/admin/payroll', payrollRouter);
  app.use('/v1/admin/overview', overviewRouter);

  app.use(errorHandler);

  return app;
}
