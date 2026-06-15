import { API_URL } from '../env';
import { log } from '../logger';
import { clearTokens, loadTokens, saveTokens, type StoredTokens } from './tokenStore';

type FetchOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
};

class UnauthorizedError extends Error {}

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

async function refreshTokens(current: StoredTokens): Promise<StoredTokens | null> {
  const res = await rawFetch('/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: current.refreshToken },
  });
  if (!res.ok) {
    log.warn('refresh failed', { status: res.status });
    return null;
  }
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  const next: StoredTokens = {
    ...current,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  };
  await saveTokens(next);
  return next;
}

/**
 * Single-flight refresh: concurrent 401s share ONE rotation. The refresh token
 * is single-use with server-side reuse detection — two parallel rotations would
 * spend it twice, trip reuse-detection, and revoke the whole token family
 * (forcing a re-login). One in-flight promise guarantees that never happens.
 */
let refreshInFlight: Promise<StoredTokens | null> | null = null;

function refreshTokensOnce(current: StoredTokens): Promise<StoredTokens | null> {
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
      throw new Error(`${path} ${firstRes.status}: ${text}`);
    }
    return (await firstRes.json()) as T;
  }

  if (!tokens) throw new UnauthorizedError('no_tokens');
  const refreshed = await refreshTokensOnce(tokens);
  if (!refreshed) {
    await clearTokens();
    notifyAuth('loggedOut');
    throw new UnauthorizedError('refresh_failed');
  }

  const secondRes = await rawFetch(path, opts, refreshed.accessToken);
  if (!secondRes.ok) {
    if (secondRes.status === 401) {
      await clearTokens();
      notifyAuth('loggedOut');
    }
    const text = await secondRes.text().catch(() => '');
    throw new Error(`${path} ${secondRes.status}: ${text}`);
  }
  return (await secondRes.json()) as T;
}

export { UnauthorizedError };
