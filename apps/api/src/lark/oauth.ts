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
