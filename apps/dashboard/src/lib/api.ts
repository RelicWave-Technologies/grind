/**
 * Tiny fetch wrapper for the dashboard. Always sends credentials so the
 * grind_at httpOnly cookie travels cross-origin in dev. Throws ApiError
 * on non-2xx, which the screens convert to friendly UI.
 *
 * Why not Bearer tokens? The browser never sees the access token — that's
 * the whole point of the cookie. The API decides which role-scope to apply
 * from the JWT it decodes server-side.
 */

const RAW_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
export const API_BASE = RAW_BASE.replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * Single-flight silent session refresh. When the short-lived access cookie
 * expires, the next request 401s; we POST /v1/auth/refresh-cookie once (the
 * httpOnly refresh cookie rotates server-side) and retry. Many concurrent 401s
 * share ONE refresh promise so we never double-spend the single-use refresh
 * token (which would trip reuse-detection and log everyone out).
 */
let refreshInFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE}/v1/auth/refresh-cookie`, {
      method: 'POST',
      credentials: 'include',
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

// The refresh/logout endpoints ARE the auth flow — never recurse into refresh
// when one of them 401s.
function isAuthEndpoint(path: string): boolean {
  return path.includes('/v1/auth/refresh-cookie') || path.includes('/v1/auth/cookie-logout');
}

export async function api<T = unknown>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = new Headers(init?.headers);
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const doFetch = () =>
    fetch(url, {
      ...init,
      headers,
      body,
      credentials: 'include',
    });

  let res = await doFetch();
  // Access cookie expired → silent refresh once, then replay the request.
  if (res.status === 401 && !isAuthEndpoint(path)) {
    const refreshed = await refreshSession();
    if (refreshed) res = await doFetch();
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`);
    throw new ApiError(res.status, parsed, msg);
  }
  return parsed as T;
}
