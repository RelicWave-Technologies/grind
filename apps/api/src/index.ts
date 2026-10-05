import { prisma } from '@grind/db';
import { env } from './env';
import { logger } from './logger';
import { buildApp } from './app';
import { startCardCallback } from './lark';
import { startLarkTokenRefreshScheduler } from './lark/refreshScheduler';
import { startAttendanceRulesScheduler } from './attendance/ruleScheduler';
import { startLarkLeaveIngest, startLarkWfhIngest } from './leave';
import { startManualTimeLarkOutboxWorker } from './manualTime/larkOutbox';
import { startPayrollMonthCloseScheduler } from './payroll/scheduler';
import { startScreenshotRetentionScheduler } from './screenshots/retention';
import { startTesterOpsSchedulers } from './testerOps/scheduler';
import { startTimerLifecycleScheduler } from './timeLifecycle';
import { installGracefulShutdown } from './lib/lifecycle';
import { startPruneScheduler } from './maintenance/prune';

const app = buildApp();

const port = env.PORT ?? env.API_PORT;
const server = app.listen(port, () => {
  logger.info({ port, env: env.NODE_ENV }, 'api listening');
  // Subscribe to Lark card.action.trigger over long-connection WebSocket.
  // No-op when Lark isn't configured.
  startCardCallback();
  startManualTimeLarkOutboxWorker();
  // Mirrors leave decided in Lark into Timo; no-op without an approval code.
  startLarkLeaveIngest();
  // Mirrors Lark "Work From Home Request" decisions; no-op without a code.
  startLarkWfhIngest();
  // Keeps the attendance rules' leave charges current between report loads.
  startAttendanceRulesScheduler();
  startLarkTokenRefreshScheduler();
  startPayrollMonthCloseScheduler();
  startScreenshotRetentionScheduler();
  startTesterOpsSchedulers();
  startTimerLifecycleScheduler(env.TIMO_TIMER_LEASE_RECONCILER_ENABLED === 'true');
  // Daily: drop spent refresh tokens, expired agent codes, settled outbox rows.
  startPruneScheduler();
});

// SIGTERM (deploy) / SIGINT: stop schedulers, finish in-flight requests,
// disconnect Prisma, exit 0 — instead of dying mid-request.
installGracefulShutdown({ server, disconnect: () => prisma.$disconnect() });
