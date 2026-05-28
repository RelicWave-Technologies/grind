import { env } from './env';
import { logger } from './logger';
import { buildApp } from './app';

const app = buildApp();

app.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT, env: env.NODE_ENV }, 'api listening');
});
