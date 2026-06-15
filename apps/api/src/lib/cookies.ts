import type { Response } from 'express';
import { env } from '../env';

/**
 * The dashboard's httpOnly access-token cookie. In production the dashboard
 * (Vercel) and API (Render) are different sites, so the cookie must be
 * `SameSite=None; Secure` to travel on the dashboard's credentialed fetches; in
 * dev they share localhost → `Lax`. One definition shared by every issuer
 * (dev-shim password login + Lark login) and the logout clear so the attributes
 * always match (a mismatch makes the browser refuse to clear the cookie).
 */
export const SESSION_COOKIE = 'grind_at';

/**
 * The dashboard's httpOnly refresh-token cookie. Scoped to `/v1/auth` so it's
 * only ever sent to the refresh/logout endpoints — it never rides along on
 * ordinary API calls, minimising exposure. The dashboard silently rotates it
 * via POST /v1/auth/refresh-cookie when the short-lived access cookie 401s,
 * giving a long (refresh-TTL) session without long-lived access tokens.
 */
export const REFRESH_COOKIE = 'grind_rt';
const REFRESH_COOKIE_PATH = '/v1/auth';

function crossSite(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function setSessionCookie(res: Response, accessToken: string): void {
  res.cookie(SESSION_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: crossSite() ? 'none' : 'lax',
    secure: crossSite(),
    // Match the access-token TTL so the browser drops a stale cookie on its own;
    // the refresh cookie (below) is what keeps the session alive past this.
    maxAge: env.JWT_ACCESS_TTL_SECONDS * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    path: '/',
    sameSite: crossSite() ? 'none' : 'lax',
    secure: crossSite(),
  });
}

export function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: crossSite() ? 'none' : 'lax',
    secure: crossSite(),
    maxAge: env.JWT_REFRESH_TTL_SECONDS * 1000,
    path: REFRESH_COOKIE_PATH,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    path: REFRESH_COOKIE_PATH,
    sameSite: crossSite() ? 'none' : 'lax',
    secure: crossSite(),
  });
}
