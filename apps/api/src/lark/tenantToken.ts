import { getLarkConfig } from './config';

/**
 * One owner of the bot's `tenant_access_token`.
 *
 * Two callers now need it — the IM messenger and the approval client — and a
 * second private copy of the fetch-and-cache dance is how two callers end up
 * with two different expiry skews and one of them silently re-authenticating
 * on every request. The cache is process-wide because the token is per app,
 * not per caller.
 */

let cached: { token: string; expiresAtMs: number } | null = null;

/** Refresh a minute early so an in-flight request never races expiry. */
const SKEW_MS = 60_000;

export async function getTenantAccessToken(nowMs = Date.now()): Promise<string> {
  if (cached && cached.expiresAtMs - SKEW_MS > nowMs) return cached.token;
  const { oauthHost, appId, appSecret } = getLarkConfig();
  const res = await fetch(`${oauthHost}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`tenant token: ${body.msg ?? body.code}`);
  }
  cached = {
    token: body.tenant_access_token,
    expiresAtMs: nowMs + (body.expire ?? 7200) * 1000,
  };
  return cached.token;
}

/** Drop the cached token — used by tests and by an auth-failure retry path. */
export function resetTenantAccessToken(): void {
  cached = null;
}
