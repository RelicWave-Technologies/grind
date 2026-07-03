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

export type OAuthState = { sub: string };

// 10 minutes is plenty to complete an interactive authorize round-trip.
const STATE_TTL_SECONDS = 600;

export function signOAuthState(userId: string): string {
  return jwt.sign({ sub: userId, kind: 'lark_oauth' }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: STATE_TTL_SECONDS,
  });
}

export function verifyOAuthState(token: string): OAuthState {
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  if (typeof decoded !== 'object' || !decoded) throw new Error('invalid state');
  const { sub, kind } = decoded as Record<string, unknown>;
  if (kind !== 'lark_oauth' || typeof sub !== 'string') throw new Error('malformed state');
  return { sub };
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
};

export function signLoginState(payload: LarkLoginStatePayload): string {
  return jwt.sign({ ...payload, kind: 'lark_login' }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: STATE_TTL_SECONDS,
  });
}

export function verifyLoginState(token: string): LarkLoginStatePayload {
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  if (typeof decoded !== 'object' || !decoded) throw new Error('invalid state');
  const { nonce, client, agentChallenge, agentCallbackScheme, kind } = decoded as Record<string, unknown>;
  if (kind !== 'lark_login') throw new Error('malformed state');
  if (typeof nonce !== 'string' || (client !== 'dashboard' && client !== 'agent')) {
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
  };
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
