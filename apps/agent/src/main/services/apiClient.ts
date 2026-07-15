import { API_URL } from '../env';
import { log } from '../logger';
import { clearTokensIfMatch, loadTokens, replaceTokensIfMatch, type StoredTokens } from './tokenStore';

type FetchOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
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
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });
}

/**
 * A refresh attempt. Success carries the new tokens; failure distinguishes a
 * DEFINITIVE rejection (401 — the refresh token is truly dead, sign out) from a
 * TRANSIENT one (5xx / 429 — keep the session and retry later). A thrown
 * network error is likewise transient: it propagates and never signs out.
 */
type RefreshOutcome =
  | { ok: true; tokens: StoredTokens }
  | { ok: false; terminal: boolean; status: number; reason: string | null };
type TokenRecovery<T> = { recovered: true; value: T } | { recovered: false };

function tokenChanged(a: StoredTokens, b: StoredTokens | null): b is StoredTokens {
  return Boolean(b && b.refreshToken !== a.refreshToken);
}

async function loadNewerTokens(current: StoredTokens): Promise<StoredTokens | null> {
  const latest = await loadTokens();
  return tokenChanged(current, latest) ? latest : null;
}

async function clearTokensIfUnchanged(current: StoredTokens): Promise<boolean> {
  if (!await clearTokensIfMatch(current)) {
    log.info('skipped logout because newer stored tokens exist');
    return false;
  }
  notifyAuth('loggedOut');
  return true;
}

async function retryWithNewerTokens<T>(
  path: string,
  opts: FetchOptions,
  current: StoredTokens,
): Promise<TokenRecovery<T>> {
  const latest = await loadNewerTokens(current);
  if (!latest) return { recovered: false };

  const res = await rawFetch(path, opts, latest.accessToken);
  if (res.ok) return { recovered: true, value: (await res.json()) as T };
  if (res.status === 401) return { recovered: false };

  const text = await res.text().catch(() => '');
  throw new HttpError(path, res.status, text);
}

async function refreshFailureReason(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { reason?: unknown; error?: unknown };
    if (typeof body.reason === 'string') return body.reason;
    if (typeof body.error === 'string') return body.error;
  } catch {
    // Ignore malformed error bodies; callers still use the HTTP status.
  }
  return null;
}

async function refreshTokens(current: StoredTokens): Promise<RefreshOutcome> {
  const res = await rawFetch('/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: current.refreshToken },
  });
  if (!res.ok) {
    const reason = await refreshFailureReason(res);
    log.warn('refresh failed', { status: res.status, reason });
    if (res.status === 409 && reason === 'reuse_grace') {
      const latest = await loadNewerTokens(current);
      if (latest) {
        log.info('refresh recovered with newer stored tokens after reuse grace');
        return { ok: true, tokens: latest };
      }
    }
    return { ok: false, terminal: res.status === 401, status: res.status, reason };
  }
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  const next: StoredTokens = {
    ...current,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  };
  if (await replaceTokensIfMatch(current, next)) return { ok: true, tokens: next };
  const latest = await loadTokens();
  if (latest) {
    log.info('refresh result discarded because the stored session changed');
    return { ok: true, tokens: latest };
  }
  return { ok: false, terminal: true, status: 401, reason: 'session_changed' };
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
  const newerTokens = await loadNewerTokens(tokens);
  const outcome: RefreshOutcome = newerTokens
    ? { ok: true, tokens: newerTokens }
    : await refreshTokensOnce(tokens);
  if (!outcome.ok) {
    // Only a definitive 401 means the refresh token is dead — sign out. A
    // transient failure (5xx/429) must NOT destroy a recoverable session:
    // surface a retryable error and keep the tokens on disk for the next try.
    if (outcome.terminal) {
      const recovered = await retryWithNewerTokens<T>(path, opts, tokens);
      if (recovered.recovered) return recovered.value;
      await clearTokensIfUnchanged(tokens);
      throw new UnauthorizedError('refresh_failed');
    }
    throw new HttpError('/v1/auth/refresh', 503, 'refresh_transient');
  }

  const secondRes = await rawFetch(path, opts, outcome.tokens.accessToken);
  if (!secondRes.ok) {
    if (secondRes.status === 401) {
      const recovered = await retryWithNewerTokens<T>(path, opts, outcome.tokens);
      if (recovered.recovered) return recovered.value;
      await clearTokensIfUnchanged(outcome.tokens);
    }
    const text = await secondRes.text().catch(() => '');
    throw new HttpError(path, secondRes.status, text);
  }
  return (await secondRes.json()) as T;
}

export { UnauthorizedError, HttpError };
