import { API_URL } from '../env';
import { log } from '../logger';
import { clearTokens, loadTokens, saveTokens, type StoredTokens } from './tokenStore';

type FetchOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
};

class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

class HttpError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${path} ${status}: ${body}`);
    this.name = 'HttpError';
  }
}

type AuthListener = (status: 'loggedIn' | 'loggedOut') => void;
const authListeners = new Set<AuthListener>();

export function onAuthChange(listener: AuthListener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function notifyAuth(status: 'loggedIn' | 'loggedOut'): void {
  for (const cb of authListeners) cb(status);
}

async function rawFetch(path: string, opts: FetchOptions, accessToken?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/**
 * A refresh attempt. Success carries the new tokens; failure distinguishes a
 * DEFINITIVE rejection (401 — the refresh token is truly dead, sign out) from a
 * TRANSIENT one (5xx / 429 — keep the session and retry later). A thrown
 * network error is likewise transient: it propagates and never signs out.
 */
type RefreshOutcome = { ok: true; tokens: StoredTokens } | { ok: false; terminal: boolean };

async function refreshTokens(current: StoredTokens): Promise<RefreshOutcome> {
  const res = await rawFetch('/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: current.refreshToken },
  });
  if (!res.ok) {
    log.warn('refresh failed', { status: res.status });
    return { ok: false, terminal: res.status === 401 };
  }
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  const next: StoredTokens = {
    ...current,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  };
  await saveTokens(next);
  return { ok: true, tokens: next };
}

/**
 * Single-flight refresh: concurrent 401s share ONE rotation. The refresh token
 * is single-use with server-side reuse detection — two parallel rotations would
 * spend it twice, trip reuse-detection, and revoke the whole token family
 * (forcing a re-login). One in-flight promise guarantees that never happens.
 */
let refreshInFlight: Promise<RefreshOutcome> | null = null;

function refreshTokensOnce(current: StoredTokens): Promise<RefreshOutcome> {
  if (!refreshInFlight) {
    refreshInFlight = refreshTokens(current).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function api<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const tokens = opts.auth === false ? null : await loadTokens();
  if (opts.auth !== false && !tokens) {
    throw new UnauthorizedError('no_tokens');
  }

  const firstRes = await rawFetch(path, opts, tokens?.accessToken);
  if (firstRes.status !== 401 || opts.auth === false) {
    if (!firstRes.ok) {
      const text = await firstRes.text().catch(() => '');
      throw new HttpError(path, firstRes.status, text);
    }
    return (await firstRes.json()) as T;
  }

  if (!tokens) throw new UnauthorizedError('no_tokens');
  const outcome = await refreshTokensOnce(tokens);
  if (!outcome.ok) {
    // Only a definitive 401 means the refresh token is dead — sign out. A
    // transient failure (5xx/429) must NOT destroy a recoverable session:
    // surface a retryable error and keep the tokens on disk for the next try.
    if (outcome.terminal) {
      await clearTokens();
      notifyAuth('loggedOut');
      throw new UnauthorizedError('refresh_failed');
    }
    throw new HttpError('/v1/auth/refresh', 503, 'refresh_transient');
  }

  const secondRes = await rawFetch(path, opts, outcome.tokens.accessToken);
  if (!secondRes.ok) {
    if (secondRes.status === 401) {
      await clearTokens();
      notifyAuth('loggedOut');
    }
    const text = await secondRes.text().catch(() => '');
    throw new HttpError(path, secondRes.status, text);
  }
  return (await secondRes.json()) as T;
}

export { UnauthorizedError, HttpError };
