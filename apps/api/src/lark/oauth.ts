import jwt from 'jsonwebtoken';
import { env } from '../env';
import { LARK_SCOPE_STRING } from './config';

/**
 * Lark OAuth v2 authorization-code flow helpers.
 *
 * The browser hits our /oauth/callback unauthenticated (no Grind JWT), so we
 * carry the initiating user's id in a signed, short-lived `state` token. This
 * doubles as CSRF protection: a callback whose state doesn't verify is rejected.
 */

export type OAuthReturnTarget = 'browser' | 'agent';
export type AgentCallbackScheme = 'grind' | 'timo';

export type OAuthState = {
  sub: string;
  returnTo: OAuthReturnTarget;
  agentCallbackScheme?: AgentCallbackScheme;
};

// 10 minutes is plenty to complete an interactive authorize round-trip.
const STATE_TTL_SECONDS = 600;

export function signOAuthState(
  userId: string,
  opts: { returnTo?: OAuthReturnTarget; agentCallbackScheme?: AgentCallbackScheme } = {},
): string {
  const returnTo = opts.returnTo ?? 'browser';
  const agentCallbackScheme = returnTo === 'agent' ? opts.agentCallbackScheme : undefined;
  if (returnTo === 'agent' && !agentCallbackScheme) throw new Error('agent callback scheme is required');
  return jwt.sign({ sub: userId, returnTo, agentCallbackScheme, kind: 'lark_oauth' }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: STATE_TTL_SECONDS,
  });
}

export function verifyOAuthState(token: string): OAuthState {
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  if (typeof decoded !== 'object' || !decoded) throw new Error('invalid state');
  const { sub, kind, returnTo, agentCallbackScheme } = decoded as Record<string, unknown>;
  if (kind !== 'lark_oauth' || typeof sub !== 'string') throw new Error('malformed state');
  // Existing browser-originated links predate returnTo. Preserve that safe default.
  const resolvedReturnTo = returnTo === undefined ? 'browser' : returnTo;
  if (resolvedReturnTo !== 'browser' && resolvedReturnTo !== 'agent') throw new Error('malformed state');
  if (agentCallbackScheme !== undefined && agentCallbackScheme !== 'grind' && agentCallbackScheme !== 'timo') {
    throw new Error('malformed state');
  }
  if (resolvedReturnTo === 'agent' && agentCallbackScheme === undefined) throw new Error('malformed state');
  return {
    sub,
    returnTo: resolvedReturnTo,
    agentCallbackScheme: agentCallbackScheme as AgentCallbackScheme | undefined,
  };
}

/**
 * Login state — carries NO user (unlike the connect flow above), since at login
 * we don't know who the user is until after the code exchange. Instead it
 * carries:
 *  - `nonce`: matched against a double-submit cookie for the dashboard (CSRF).
 *  - `client`: 'dashboard' | 'agent' — selects session delivery (cookie vs
 *     deep-link) at the callback.
 *  - `agentChallenge`: the agent's PKCE S256 challenge, bound to the one-time
 *     code so only the agent that started the flow can redeem it.
 *  - `agentCallbackScheme`: the custom URL scheme to redirect back to. New
 *     Timo agents use `timo`; old Grind agents default to `grind`.
 * Signed + short-TTL with our JWT secret, so a forged/expired state is rejected.
 */
export type LarkLoginStatePayload = {
  nonce: string;
  client: 'dashboard' | 'agent';
  agentChallenge?: string;
  agentCallbackScheme?: 'grind' | 'timo';
  nextPath?: string;
};

function isSafeDashboardPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !/[\u0000-\u001F\u007F]/u.test(value);
}

export function signLoginState(payload: LarkLoginStatePayload): string {
  if (payload.nextPath !== undefined && !isSafeDashboardPath(payload.nextPath)) {
    throw new Error('unsafe dashboard return path');
  }
  return jwt.sign({ ...payload, kind: 'lark_login' }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: STATE_TTL_SECONDS,
  });
}

export function verifyLoginState(token: string): LarkLoginStatePayload {
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  if (typeof decoded !== 'object' || !decoded) throw new Error('invalid state');
  const { nonce, client, agentChallenge, agentCallbackScheme, nextPath, kind } = decoded as Record<string, unknown>;
  if (kind !== 'lark_login') throw new Error('malformed state');
  if (typeof nonce !== 'string' || (client !== 'dashboard' && client !== 'agent')) {
    throw new Error('malformed state');
  }
  if (nextPath !== undefined && (typeof nextPath !== 'string' || !isSafeDashboardPath(nextPath))) {
    throw new Error('malformed state');
  }
  if (agentChallenge !== undefined && typeof agentChallenge !== 'string') {
    throw new Error('malformed state');
  }
  if (agentCallbackScheme !== undefined && agentCallbackScheme !== 'grind' && agentCallbackScheme !== 'timo') {
    throw new Error('malformed state');
  }
  return {
    nonce,
    client,
    agentChallenge: agentChallenge as string | undefined,
    agentCallbackScheme: agentCallbackScheme as 'grind' | 'timo' | undefined,
    nextPath: nextPath as string | undefined,
  };
}

export type AgentLoginRouteHint = {
  client: 'agent';
  agentCallbackScheme: 'grind' | 'timo';
};

/**
 * Recover only the signed client-routing hint from an expired login state.
 *
 * This intentionally ignores expiration but still verifies the JWT signature
 * and token kind. Callers must use the result only for terminal error routing,
 * never for identity, session issuance, or token exchange.
 */
export function verifyExpiredAgentLoginRouteHint(token: string): AgentLoginRouteHint | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      ignoreExpiration: true,
    });
    if (typeof decoded !== 'object' || !decoded) return null;
    const { kind, client, agentCallbackScheme } = decoded as Record<string, unknown>;
    if (kind !== 'lark_login' || client !== 'agent') return null;
    if (agentCallbackScheme !== undefined && agentCallbackScheme !== 'grind' && agentCallbackScheme !== 'timo') {
      return null;
    }
    return { client: 'agent', agentCallbackScheme: agentCallbackScheme === 'timo' ? 'timo' : 'grind' };
  } catch {
    return null;
  }
}

/**
 * Build the Lark OAuth v2 authorize URL. Hosted on the accounts host
 * (accounts.larksuite.com) per Lark's OAuth v2 docs.
 */
export function buildAuthorizeUrl(opts: {
  accountsHost: string;
  appId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const url = new URL('/open-apis/authen/v1/authorize', opts.accountsHost);
  url.searchParams.set('client_id', opts.appId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', opts.scope ?? LARK_SCOPE_STRING);
  url.searchParams.set('state', opts.state);
  return url.toString();
}
