import type { ErrorRequestHandler } from 'express';
import { logger } from '../logger';
import { reportError } from '../lib/errorReporter';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
  // Fire-and-forget Sentry (no-op when SENTRY_DSN is unset).
  void reportError(err, {
    path: req.path,
    method: req.method,
    userId: (req as { user?: { sub?: string } }).user?.sub,
  });
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
};
