import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { prisma } from '@grind/db';
import { logger } from './logger';
import { API_VERSION, START_TIME_MS } from './lib/version';
import { authRouter } from './routes/auth';
import { agentRouter } from './routes/agent';
import { timeEntriesRouter } from './routes/timeEntries';
import { activityRouter } from './routes/activity';
import { larkRouter } from './routes/lark';
import { insightsRouter } from './routes/insights';
import { reportsRouter } from './routes/reports';
import { profileRouter } from './routes/profile';
import { timeRequestsRouter } from './routes/timeRequests';
import { screenshotsRouter } from './routes/screenshots';
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
  // CORS: allow credentials so the dashboard (separate origin) can ship the
  // grind_at cookie. In production, restrict to the configured dashboard
  // origin(s) — DASHBOARD_URL may be a comma-separated list (e.g. the prod
  // domain plus Vercel preview URLs). In dev with nothing configured we
  // reflect the request origin so localhost:5174 just works.
  const allowlist = (process.env.DASHBOARD_URL ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  app.use(
    cors({
      origin: allowlist.length
        ? (origin, cb) => {
            // Allow same-origin / non-browser callers (no Origin header), e.g.
            // the agent and health probes.
            if (!origin || allowlist.includes(origin.replace(/\/$/, ''))) return cb(null, true);
            return cb(new Error('not_allowed_by_cors'));
          }
        : true,
      credentials: true,
    }),
  );
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

  // Liveness probe (no auth, no DB) — used by load balancers + uptime checks.
  // Cheap on purpose: a 1ms response per check.
  app.get('/health', (_req, res) => res.json({ ok: true }));

  /**
   * Readiness probe — returns 200 with a structured payload when the API
   * can serve real traffic (DB reachable), 503 when it can't. Reports
   * the build version + uptime so deploys can be sanity-checked from a
   * curl. Two-second DB timeout to keep the probe predictable under
   * Postgres pressure.
   */
  app.get('/healthz', async (_req, res) => {
    const uptimeSec = Math.floor((Date.now() - START_TIME_MS) / 1000);
    const dbStart = Date.now();
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error('db_timeout')), 2000)),
      ]);
      res.json({
        ok: true,
        version: API_VERSION,
        uptimeSec,
        db: { ok: true, latencyMs: Date.now() - dbStart },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({
        ok: false,
        version: API_VERSION,
        uptimeSec,
        db: { ok: false, error: msg, latencyMs: Date.now() - dbStart },
      });
    }
  });

  app.use('/v1/auth', authRouter);
  app.use('/v1/agent', agentRouter);
  app.use('/v1/time-entries', timeEntriesRouter);
  app.use('/v1/activity-samples', activityRouter);
  app.use('/v1/lark', larkRouter);
  app.use('/v1/insights', insightsRouter);
  app.use('/v1/reports', reportsRouter);
  app.use('/v1/profile', profileRouter);
  app.use('/v1/time-requests', timeRequestsRouter);
  app.use('/v1/screenshots', screenshotsRouter);
  app.use('/v1/admin', adminRouter);
  app.use('/v1/workspace', workspaceRouter);
  app.use('/v1/admin/workspace-policy', workspacePolicyRouter);
  app.use('/v1/admin/digests', digestsRouter);
  app.use('/v1/admin/payroll', payrollRouter);
  app.use('/v1/admin/overview', overviewRouter);

  app.use(errorHandler);

  return app;
}
