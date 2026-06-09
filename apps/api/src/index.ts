import { env } from './env';
import { logger } from './logger';
import { buildApp } from './app';
import { startCardCallback } from './lark';
import { startPayrollMonthCloseScheduler } from './payroll/scheduler';

const app = buildApp();

app.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT, env: env.NODE_ENV }, 'api listening');
  // Subscribe to Lark card.action.trigger over long-connection WebSocket.
  // No-op when Lark isn't configured.
  startCardCallback();
  startPayrollMonthCloseScheduler();
});
