import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

export function validate(schema: ZodTypeAny, source: 'body' | 'query' | 'params' = 'body'): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      // Where it failed, never the values: a field name and a zod code are
      // enough to find a stuck client, and request bodies carry user data.
      req.log?.warn({
        issues: result.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      }, 'request validation failed');
      return res.status(400).json({
        error: 'validation_failed',
        details: result.error.flatten(),
      });
    }
    req[source] = result.data;
    next();
  };
}
