import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { prisma } from '@grind/db';
import { logger } from './logger';
import { requestLogLevel } from './lib/requestLogLevel';
import { dashboardOrigins } from './env';
import { API_VERSION, START_TIME_MS } from './lib/version';
import { authRouter } from './routes/auth';
import { authLarkRouter } from './routes/authLark';
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
import { mcpRouter } from './routes/mcp';
import { workspaceRouter } from './routes/workspace';
import { workspacePolicyRouter } from './routes/workspacePolicy';
import { adminLeaveRouter, leaveRouter } from './routes/leave';
import { overviewRouter } from './routes/overview';
import { downloadsRouter } from './routes/downloads';
import { devRouter } from './routes/dev';
import { errorHandler } from './middleware/errorHandler';

export function buildApp() {
  const app = express();
  // nginx on the host terminates every request and appends the client to
  // X-Forwarded-For. Trust only the hops in front of us — loopback, plus the
  // Docker bridge gateway (a private address) that the published
  // 127.0.0.1:4100 port forwards through — so req.ip is the client, and a
  // client-sent X-Forwarded-For can never stand in for it.
  app.set('trust proxy', ['loopback', 'uniquelocal']);

  app.use(helmet());
  app.use(compression());
  // CORS: allow credentials so the dashboard (separate origin) can ship the
  // grind_at cookie. Restricted to the configured dashboard origin(s) —
  // DASHBOARD_URL may be a comma-separated list, and env.ts refuses to start
  // production without it. In dev with nothing configured we reflect the
  // request origin so localhost:5174 just works.
  const allowlist = dashboardOrigins();
  app.use(
    cors({
      origin: allowlist.length
        ? (origin, cb) => {
            // Allow same-origin / non-browser callers (no Origin header), e.g.
            // the agent and health probes.
            if (!origin || allowlist.includes(origin.replace(/\/$/, ''))) return cb(null, true);
            // A 403 the error handler answers as such — not a 500 that pages
            // Sentry every time a stray origin probes the API.
            return cb(Object.assign(new Error('not_allowed_by_cors'), { status: 403, code: 'cors_rejected' }));
          }
        : true,
      credentials: true,
    }),
  );
  app.use(cookieParser());
  // Agent upload routes whose bodies legitimately outgrow the default cap: up to
  // 500 activity samples, up to 50 app icons of up to 200k each, and a long
  // day's entry with hundreds of segments. A 413 there is never fixed by a
  // retry, so the agent resent the same body forever and queued work behind it.
  // Every other route stays tight at 64kb. Registered first on purpose —
  // express.json is a no-op once the body has been parsed, so the global parser
  // below skips an already-parsed body.
  app.use(['/v1/activity-samples', '/v1/agent/app-icons', '/v1/time-entries'], express.json({ limit: '1mb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use(
    pinoHttp({
      logger,
      customLogLevel: (req, res, err) =>
        requestLogLevel(req.method, (req as express.Request).originalUrl ?? req.url, res.statusCode, err),
      redact: {
        // Cookies carry the dashboard session (grind_at / grind_rt), and
        // Set-Cookie hands out a fresh 90-day refresh token: anyone reading
        // the logs could take over a session.
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.refreshToken',
        ],
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

  // Lark login (browser-facing, unauthenticated) — mount before /v1/auth so its
  // /lark/* paths are handled by the dedicated router.
  app.use('/v1/auth/lark', authLarkRouter);
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
  app.use('/v1/downloads', downloadsRouter);
  app.use('/v1/mcp', mcpRouter);
  // The /v1/admin/* sub-routers go BEFORE the generic admin router. Mounted
  // after it, every request to them first ran adminRouter's auth + scope
  // middleware (a user lookup and a workspace-wide user list) and then its own
  // again, for nothing.
  app.use('/v1/admin/workspace-policy', workspacePolicyRouter);
  app.use('/v1/admin/leave', adminLeaveRouter);
  app.use('/v1/admin/overview', overviewRouter);
  app.use('/v1/admin', adminRouter);
  app.use('/v1/workspace', workspaceRouter);
  app.use('/v1/leave', leaveRouter);
  // Developer-only tools (DEVELOPER_EMAILS); 404 for everyone else.
  app.use('/v1/dev', devRouter);

  app.use(errorHandler);

  return app;
}
