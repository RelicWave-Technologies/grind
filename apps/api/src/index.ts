import { env } from './env';
import { logger } from './logger';
import { buildApp } from './app';
import { startCardCallback } from './lark';
import { startLarkTokenRefreshScheduler } from './lark/refreshScheduler';
import { startPayrollMonthCloseScheduler } from './payroll/scheduler';
import { startScreenshotRetentionScheduler } from './screenshots/retention';

const app = buildApp();

const port = env.PORT ?? env.API_PORT;
app.listen(port, () => {
  logger.info({ port, env: env.NODE_ENV }, 'api listening');
  // Subscribe to Lark card.action.trigger over long-connection WebSocket.
  // No-op when Lark isn't configured.
  startCardCallback();
  startLarkTokenRefreshScheduler();
  startPayrollMonthCloseScheduler();
  startScreenshotRetentionScheduler();
});
