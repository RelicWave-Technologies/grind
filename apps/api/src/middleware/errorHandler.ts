import type { ErrorRequestHandler } from 'express';
import { logger } from '../logger';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error({ err }, 'unhandled error');
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
};
