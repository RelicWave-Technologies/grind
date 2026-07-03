import { getLarkConfig, LARK_SCOPE_STRING } from './config';

/**
 * The subset of the Lark OAuth v2 token endpoint we depend on. Defining it as
 * an interface lets the TokenManager be tested against a fake (no network,
 * deterministic rotation) while the real implementation talks to Lark.
 *
 * Lark OAuth v2 refresh tokens are SINGLE-USE: every successful exchange or
 * refresh returns a NEW refresh_token and invalidates the old one. The caller
 * MUST persist the new refresh_token before relying on the access_token.
 */
export interface LarkTokenResponse {
  accessToken: string;
  accessExpiresInSec: number;
  refreshToken: string;
  refreshExpiresInSec: number;
  scope: string;
}

export interface OAuthClient {
  /** Exchange an authorization code for the first token pair. */
  exchangeCode(code: string, redirectUri: string): Promise<LarkTokenResponse>;
  /** Rotate a single-use refresh token into a fresh token pair. */
  refresh(refreshToken: string): Promise<LarkTokenResponse>;
}

/** Thrown when Lark rejects a refresh token (expired / already used / revoked). */
export class LarkReauthRequiredError extends Error {
  constructor(message = 'Lark refresh token rejected; reconnect required') {
    super(message);
    this.name = 'LarkReauthRequiredError';
  }
}

/**
 * Thrown for RETRYABLE transport failures — a network error reaching Lark, or a
 * Lark 5xx/429. The single-use refresh token was NOT consumed by Lark in these
 * cases, so the caller must keep the connection and retry later rather than
 * forcing the user to reconnect. (If the token actually *was* consumed and the
 * response was merely lost, the next attempt fails with an explicit
 * LarkReauthRequiredError and converges to reconnect — never a double-spend.)
 */
export class LarkTransientError extends Error {
  constructor(message = 'Lark token endpoint transient failure') {
    super(message);
    this.name = 'LarkTransientError';
  }
}

type RawTokenBody = {
  code?: number;
  error?: string;
  error_description?: string;
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
};

const TOKEN_ENDPOINT_TIMEOUT_MS = 10_000;

function parseBody(body: RawTokenBody): LarkTokenResponse {
  // Lark v2 returns code:0 on success; non-zero (or an OAuth `error`) is failure.
  const failed = (body.code != null && body.code !== 0) || Boolean(body.error);
  if (failed || !body.access_token || !body.refresh_token) {
    const msg = body.error_description || body.error || `lark token error (code ${body.code})`;
    throw new LarkReauthRequiredError(msg);
  }
  return {
    accessToken: body.access_token,
    accessExpiresInSec: body.expires_in ?? 7200,
    refreshToken: body.refresh_token,
    refreshExpiresInSec: body.refresh_token_expires_in ?? 60 * 60 * 24 * 7,
    scope: body.scope ?? LARK_SCOPE_STRING,
  };
}

/** Real OAuth client hitting Lark's OAuth v2 token endpoint. */
export class HttpOAuthClient implements OAuthClient {
  private get tokenUrl(): string {
    return `${getLarkConfig().oauthHost}/open-apis/authen/v2/oauth/token`;
  }

  private async post(payload: Record<string, string>): Promise<LarkTokenResponse> {
    const { appId, appSecret } = getLarkConfig();
    let res: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOKEN_ENDPOINT_TIMEOUT_MS);
    timeout.unref?.();
    try {
      res = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ client_id: appId, client_secret: appSecret, ...payload }),
        signal: controller.signal,
      });
    } catch (err) {
      // Couldn't reach Lark at all → the grant was never processed; retryable.
      throw new LarkTransientError(`network error reaching Lark token endpoint: ${String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
    const body = (await res.json().catch(() => ({}))) as RawTokenBody;
    // A 5xx/429 WITHOUT an explicit OAuth error means Lark didn't process the
    // grant (server error / rate limit) — keep the token, retry later. An
    // explicit OAuth error (any status) falls through to parseBody → reauth.
    if (!res.ok && !body.error && (res.status >= 500 || res.status === 429)) {
      throw new LarkTransientError(`lark token endpoint ${res.status}`);
    }
    return parseBody(body);
  }

  exchangeCode(code: string, redirectUri: string): Promise<LarkTokenResponse> {
    return this.post({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  refresh(refreshToken: string): Promise<LarkTokenResponse> {
    return this.post({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }
}
