import { API_URL } from '../env';
import { log } from '../logger';
import { ApiNetworkError, resolveNetworkFetch } from './network';
import { clearTokensIfMatch, loadTokens, replaceTokensIfMatch, type StoredTokens } from './tokenStore';

type FetchOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * Build the body from the session the request is actually sent with. Used by
   * logout: a 401 makes api() rotate the refresh token, and a body captured up
   * front would then name the token that rotation just spent.
   */
  bodyFromTokens?: (tokens: StoredTokens) => unknown;
  auth?: boolean;
  /** Reported to auth listeners if this request ends the session (default `session_ended`). */
  signOutReason?: SignOutReason;
  /** Per-call override of {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
};

/**
 * Every request is bounded. Without one, a request the network swallowed (a
 * proxy that accepts and never answers, a half-open socket after sleep) held
 * its caller forever — boot, sign-in, and the shift fetch all awaited one.
 */
export const DEFAULT_TIMEOUT_MS = 20_000;
const REFRESH_TIMEOUT_MS = 15_000;

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

export type AuthStatus = 'loggedIn' | 'loggedOut';
/**
 * Why the session ended. `manual` is the user pressing Sign out — they know,
 * so nothing announces it. `session_ended` is the server refusing the session.
 */
export type SignOutReason = 'manual' | 'session_ended';
export type AuthChangeInfo = { reason?: SignOutReason };
type AuthListener = (status: AuthStatus, info: AuthChangeInfo) => void;
const authListeners = new Set<AuthListener>();

export function onAuthChange(listener: AuthListener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

/** Tell every auth listener the session changed. One throwing listener never
 *  starves the rest — the sign-in follow-up work lives in several of them. */
export function notifyAuth(status: AuthStatus, info: AuthChangeInfo = {}): void {
  for (const cb of authListeners) {
    try {
      cb(status, info);
    } catch (err) {
      log.warn('auth listener failed', { status, err: String(err) });
    }
  }
}

/** Only a local ngrok tunnel needs its interstitial skipped; production never does. */
const NGROK_API = /ngrok/i.test(API_URL);

async function rawFetch(path: string, opts: FetchOptions, tokens?: StoredTokens | null): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (NGROK_API) headers['ngrok-skip-browser-warning'] = 'true';
  if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
  const body = opts.bodyFromTokens && tokens ? opts.bodyFromTokens(tokens) : opts.body;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await resolveNetworkFetch()(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Bearer tokens only, as with Node's fetch: Chromium's stack would
      // otherwise keep and replay any Set-Cookie in the app session.
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const wrapped = new ApiNetworkError(path, err);
    log.warn('api request got no response', {
      path: path.split('?')[0],
      code: wrapped.code,
      timedOut: wrapped.timedOut,
      tlsIntercepted: wrapped.tlsIntercepted,
      err: String(err),
    });
    throw wrapped;
  }
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

async function clearTokensIfUnchanged(current: StoredTokens, reason: SignOutReason): Promise<boolean> {
  if (!await clearTokensIfMatch(current)) {
    log.info('skipped logout because newer stored tokens exist');
    return false;
  }
  notifyAuth('loggedOut', { reason });
  return true;
}

async function retryWithNewerTokens<T>(
  path: string,
  opts: FetchOptions,
  current: StoredTokens,
): Promise<TokenRecovery<T>> {
  const latest = await loadNewerTokens(current);
  if (!latest) return { recovered: false };

  const res = await rawFetch(path, opts, latest);
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

/**
 * Send the refresh, retrying ONCE straight away when no answer came back.
 *
 * A timeout does not mean the server did nothing: it may have rotated the token
 * and lost the reply. The server keeps that rotation's result for a 30-second
 * reuse grace and hands the same successor back to a replay of the spent
 * token — but only inside that window. Waiting for the next scheduled request
 * (a heartbeat is a minute away) lands outside it, where the replay reads as
 * token theft and the whole family is revoked. So the retry is immediate.
 */
async function sendRefresh(current: StoredTokens): Promise<Response> {
  const request = () => rawFetch('/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken: current.refreshToken },
    // Bounded like every other call: an unanswered refresh would otherwise hold
    // the single-flight slot, and every request waiting on it, for minutes.
    timeoutMs: REFRESH_TIMEOUT_MS,
  });
  try {
    return await request();
  } catch (err) {
    if (!(err instanceof ApiNetworkError)) throw err;
    log.warn('refresh got no response; retrying once inside the reuse grace', { code: err.code, timedOut: err.timedOut });
    return request();
  }
}

async function refreshTokens(current: StoredTokens): Promise<RefreshOutcome> {
  const res = await sendRefresh(current);
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

  const firstRes = await rawFetch(path, opts, tokens);
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
      await clearTokensIfUnchanged(tokens, opts.signOutReason ?? 'session_ended');
      throw new UnauthorizedError('refresh_failed');
    }
    throw new HttpError('/v1/auth/refresh', 503, 'refresh_transient');
  }

  const secondRes = await rawFetch(path, opts, outcome.tokens);
  if (!secondRes.ok) {
    if (secondRes.status === 401) {
      const recovered = await retryWithNewerTokens<T>(path, opts, outcome.tokens);
      if (recovered.recovered) return recovered.value;
      await clearTokensIfUnchanged(outcome.tokens, opts.signOutReason ?? 'session_ended');
    }
    const text = await secondRes.text().catch(() => '');
    throw new HttpError(path, secondRes.status, text);
  }
  return (await secondRes.json()) as T;
}

export { UnauthorizedError, HttpError, ApiNetworkError };
