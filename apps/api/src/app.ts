import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { logger } from './logger';
import { authRouter } from './routes/auth';
import { agentRouter } from './routes/agent';
import { timeEntriesRouter } from './routes/timeEntries';
import { activityRouter } from './routes/activity';
import { larkRouter } from './routes/lark';
import { insightsRouter } from './routes/insights';
import { errorHandler } from './middleware/errorHandler';

export function buildApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: true, credentials: false }));
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

  app.use(errorHandler);

  return app;
}
