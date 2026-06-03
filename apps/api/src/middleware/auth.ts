import type { RequestHandler } from 'express';
import { verifyAccessToken, type AccessTokenPayload } from '../lib/jwt';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

/**
 * Accepts the access token from either source:
 *   - `Authorization: Bearer <token>` header (agent + API clients)
 *   - `grind_at` httpOnly cookie (dashboard browser)
 *
 * Header takes precedence so an explicit Authorization always wins.
 */
export const requireAccessToken: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  let token: string | undefined;
  if (header?.startsWith('Bearer ')) {
    token = header.slice('Bearer '.length).trim();
  } else if ((req as unknown as { cookies?: Record<string, string> }).cookies?.grind_at) {
    token = String((req as unknown as { cookies: Record<string, string> }).cookies.grind_at).trim();
  }
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
};
