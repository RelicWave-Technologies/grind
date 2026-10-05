import { app, net } from 'electron';

/**
 * The one way the main process talks to the network.
 *
 * Node's built-in fetch (undici) ships its own CA bundle and ignores the OS
 * proxy settings. On a corporate network that terminates TLS (Fortinet and
 * friends re-sign every certificate with a root that IT installed into the OS
 * store) or that only allows traffic through a configured proxy, every request
 * failed — sign-in reported `auth_failed`, heartbeats never arrived — while the
 * browser on the same machine worked. Electron's `net.fetch` runs on Chromium's
 * network stack instead: it trusts the OS certificate store and honours the
 * system proxy, exactly like the browser the user just signed in with.
 *
 * `net.fetch` is only usable in the main process once the app is ready, and is
 * absent entirely under vitest (where `electron` resolves to a path string), so
 * resolution falls back to the global fetch. Tests inject their own with
 * {@link setNetworkFetchForTests}.
 *
 * The screenshot uploader still calls the global fetch directly; switching it
 * is a one-line change to {@link networkFetch}.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let override: FetchLike | null = null;

/** Test seam: route every request through `fetchImpl`; `null` restores the default. */
export function setNetworkFetchForTests(fetchImpl: FetchLike | null): void {
  override = fetchImpl;
}

function electronFetch(): FetchLike | null {
  try {
    if (typeof net?.fetch !== 'function') return null;
    if (typeof app?.isReady !== 'function' || !app.isReady()) return null;
    return (input, init) => net.fetch(input, init);
  } catch {
    return null;
  }
}

export function resolveNetworkFetch(): FetchLike {
  return override ?? electronFetch() ?? ((input, init) => globalThis.fetch(input, init));
}

/** Drop-in replacement for `fetch` that uses the OS network stack. */
export function networkFetch(input: string, init?: RequestInit): Promise<Response> {
  return resolveNetworkFetch()(input, init);
}

/**
 * Certificate failures that mean "something between this machine and the
 * server re-signed the connection". Node reports these as OpenSSL codes on
 * `err.cause.code`; Chromium reports them as `net::ERR_CERT_*` messages.
 */
const TLS_CODE_PATTERN = /^(UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_[A-Z_]+|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_[A-Z_]+)$/;
const TLS_MESSAGE_PATTERN = /net::ERR_(CERT_[A-Z_]+|SSL_[A-Z_]+|BAD_SSL_CLIENT_AUTH_CERT)|self[- ]signed certificate|unable to get (local )?issuer certificate|unable to verify the first certificate/i;

export interface NetworkErrorInfo {
  /** Best low-level code we could find (`ECONNRESET`, `SELF_SIGNED_CERT_IN_CHAIN`, `net::ERR_…`). */
  code: string | null;
  message: string;
  /** A TLS-inspecting proxy (or a broken clock) rejected the certificate. */
  tlsIntercepted: boolean;
  timedOut: boolean;
}

function readCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function readMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === 'string' ? value : '';
}

export function describeNetworkError(err: unknown): NetworkErrorInfo {
  if (err instanceof ApiNetworkError) {
    return { code: err.code, message: err.message, tlsIntercepted: err.tlsIntercepted, timedOut: err.timedOut };
  }
  const cause = err && typeof err === 'object' ? (err as { cause?: unknown }).cause : undefined;
  const nested = cause && typeof cause === 'object' ? (cause as { cause?: unknown }).cause : undefined;
  const messages = [readMessage(err), readMessage(cause), readMessage(nested)].filter(Boolean);
  const chromiumCode = messages.map((m) => /net::ERR_[A-Z_]+/.exec(m)?.[0]).find(Boolean) ?? null;
  const code = readCode(cause) ?? readCode(nested) ?? readCode(err) ?? chromiumCode;
  const name = err instanceof Error ? err.name : '';
  const tlsIntercepted = (code !== null && TLS_CODE_PATTERN.test(code))
    || messages.some((m) => TLS_MESSAGE_PATTERN.test(m));
  return {
    code,
    message: messages[0] ?? String(err),
    tlsIntercepted,
    timedOut: name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT' || code === 'net::ERR_TIMED_OUT',
  };
}

export function isTlsInterceptionError(err: unknown): boolean {
  return describeNetworkError(err).tlsIntercepted;
}

/**
 * A request that never got an HTTP answer. Extends TypeError on purpose: that
 * is what `fetch` throws for the same failure, and callers (the screenshot
 * uploader) classify "unreachable" by it.
 */
export class ApiNetworkError extends TypeError {
  readonly code: string | null;
  readonly tlsIntercepted: boolean;
  readonly timedOut: boolean;

  constructor(readonly path: string, cause: unknown) {
    const info = describeNetworkError(cause);
    super(`${path} unreachable: ${info.code ?? info.message}`, { cause });
    this.name = 'ApiNetworkError';
    this.code = info.code;
    this.tlsIntercepted = info.tlsIntercepted;
    this.timedOut = info.timedOut;
  }
}
