import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

export function validate(schema: ZodTypeAny, source: 'body' | 'query' | 'params' = 'body'): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        error: 'validation_failed',
        details: result.error.flatten(),
      });
    }
    req[source] = result.data;
    next();
  };
}
