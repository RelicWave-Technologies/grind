import type { ErrorRequestHandler } from 'express';
import { logger } from '../logger';
import { reportError } from '../lib/errorReporter';

/** Client errors raised before a route runs, mapped to a stable error code. */
const CLIENT_ERROR_CODES: Record<string, string> = {
  'entity.too.large': 'payload_too_large',
  'entity.parse.failed': 'invalid_json',
  'encoding.unsupported': 'unsupported_encoding',
  'charset.unsupported': 'unsupported_charset',
  'request.aborted': 'request_aborted',
  'request.size.invalid': 'invalid_request_size',
};

/**
 * The 4xx status an error carries, if any. body-parser sets `status` /
 * `statusCode` (413 for an oversized body, 400 for malformed JSON) and the CORS
 * gate tags its rejection with 403. Those are the caller's mistake, not ours:
 * answering them 500 and paging Sentry hid real failures behind noise.
 */
export function clientErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { status?: unknown; statusCode?: unknown };
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null;
  return status !== null && status >= 400 && status < 500 ? status : null;
}

function clientErrorCode(err: unknown, status: number): string {
  const e = err as { type?: unknown; code?: unknown; message?: unknown };
  if (typeof e.type === 'string' && CLIENT_ERROR_CODES[e.type]) return CLIENT_ERROR_CODES[e.type]!;
  if (typeof e.code === 'string' && /^[a-z_]+$/u.test(e.code)) return e.code;
  if (status === 413) return 'payload_too_large';
  if (status === 403) return 'forbidden';
  return 'bad_request';
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const status = clientErrorStatus(err);
  if (status !== null) {
    const error = clientErrorCode(err, status);
    logger.warn({ status, error, path: req.path, method: req.method }, 'request rejected');
    if (res.headersSent) return;
    res.status(status).json({ error });
    return;
  }

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
