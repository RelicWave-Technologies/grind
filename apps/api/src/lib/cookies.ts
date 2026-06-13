import type { Response } from 'express';

/**
 * The dashboard's httpOnly access-token cookie. In production the dashboard
 * (Vercel) and API (Render) are different sites, so the cookie must be
 * `SameSite=None; Secure` to travel on the dashboard's credentialed fetches; in
 * dev they share localhost → `Lax`. One definition shared by every issuer
 * (dev-shim password login + Lark login) and the logout clear so the attributes
 * always match (a mismatch makes the browser refuse to clear the cookie).
 */
export const SESSION_COOKIE = 'grind_at';
const COOKIE_MAX_AGE_MS = 60 * 60 * 1000; // 1h — matches the access-token TTL

function crossSite(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function setSessionCookie(res: Response, accessToken: string): void {
  res.cookie(SESSION_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: crossSite() ? 'none' : 'lax',
    secure: crossSite(),
    maxAge: COOKIE_MAX_AGE_MS,
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
