/**
 * Tiny fetch wrapper for the dashboard. Always sends credentials so the
 * grind_at httpOnly cookie travels cross-origin in dev. Throws ApiError
 * on non-2xx, which the screens convert to friendly UI.
 *
 * Why not Bearer tokens? The browser never sees the access token — that's
 * the whole point of the cookie. The API decides which role-scope to apply
 * from the JWT it decodes server-side.
 */

const RAW_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:4000';
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
  const res = await fetch(url, {
    ...init,
    headers,
    body,
    credentials: 'include',
  });
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
