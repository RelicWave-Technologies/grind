import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  signOAuthState,
  verifyOAuthState,
  buildAuthorizeUrl,
  signLoginState,
  verifyLoginState,
  verifyExpiredAgentLoginRouteHint,
} from './oauth';

beforeAll(() => {
  // env.ts requires a >=32-char secret; ensure one is present for these unit tests.
  process.env.JWT_SECRET ||= 'unit-test-secret-must-be-at-least-32-chars';
});

describe('OAuth state token', () => {
  it('round-trips the user id', () => {
    const tok = signOAuthState('user_123');
    expect(verifyOAuthState(tok)).toEqual({ sub: 'user_123' });
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ sub: 'x', kind: 'lark_oauth' }, 'some-other-secret-32-chars-long-xx', {
      algorithm: 'HS256',
    });
    expect(() => verifyOAuthState(forged)).toThrow();
  });

  it('rejects a token of the wrong kind (e.g. an access token replayed as state)', () => {
    const wrong = jwt.sign({ sub: 'x', ws: 'w', role: 'MEMBER' }, process.env.JWT_SECRET!, {
      algorithm: 'HS256',
    });
    expect(() => verifyOAuthState(wrong)).toThrow(/malformed/);
  });

  it('rejects an expired state token', () => {
    const expired = jwt.sign({ sub: 'x', kind: 'lark_oauth' }, process.env.JWT_SECRET!, {
      algorithm: 'HS256',
      expiresIn: -10,
    });
    expect(() => verifyOAuthState(expired)).toThrow();
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds a well-formed authorize URL with all required params', () => {
    const url = new URL(
      buildAuthorizeUrl({
        accountsHost: 'https://accounts.larksuite.com',
        appId: 'cli_test',
        redirectUri: 'http://localhost:4000/v1/lark/oauth/callback',
        state: 'state-token',
        scope: 'a b c',
      }),
    );
    expect(url.origin).toBe('https://accounts.larksuite.com');
    expect(url.pathname).toBe('/open-apis/authen/v1/authorize');
    expect(url.searchParams.get('client_id')).toBe('cli_test');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/v1/lark/oauth/callback',
    );
    expect(url.searchParams.get('scope')).toBe('a b c');
    expect(url.searchParams.get('state')).toBe('state-token');
  });

  it('url-encodes the redirect_uri and scope', () => {
    const raw = buildAuthorizeUrl({
      accountsHost: 'https://accounts.larksuite.com',
      appId: 'cli_test',
      redirectUri: 'http://localhost:4000/cb?x=1&y=2',
      state: 's',
      scope: 'task:task:read offline_access',
    });
    // spaces and ampersands must be percent-encoded in the query string
    expect(raw).toContain('scope=task%3Atask%3Aread+offline_access');
    expect(raw).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A4000%2Fcb%3Fx%3D1%26y%3D2');
  });

  it('defaults to the full requested scope set when omitted', () => {
    const url = new URL(
      buildAuthorizeUrl({
        accountsHost: 'https://accounts.larksuite.com',
        appId: 'cli_test',
        redirectUri: 'http://localhost:4000/cb',
        state: 's',
      }),
    );
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });
});

describe('Lark login state token', () => {
  it('round-trips a dashboard nonce', () => {
    const tok = signLoginState({ nonce: 'n1', client: 'dashboard' });
    expect(verifyLoginState(tok)).toEqual({
      nonce: 'n1',
      client: 'dashboard',
      agentChallenge: undefined,
      agentCallbackScheme: undefined,
    });
  });

  it('round-trips an agent challenge', () => {
    const tok = signLoginState({ nonce: 'n2', client: 'agent', agentChallenge: 'chal' });
    expect(verifyLoginState(tok)).toEqual({
      nonce: 'n2',
      client: 'agent',
      agentChallenge: 'chal',
      agentCallbackScheme: undefined,
    });
  });

  it('round-trips an agent callback scheme', () => {
    const tok = signLoginState({
      nonce: 'n3',
      client: 'agent',
      agentChallenge: 'chal',
      agentCallbackScheme: 'timo',
    });
    expect(verifyLoginState(tok)).toEqual({
      nonce: 'n3',
      client: 'agent',
      agentChallenge: 'chal',
      agentCallbackScheme: 'timo',
    });
  });

  it('rejects an arbitrary agent callback scheme', () => {
    const bad = jwt.sign(
      { nonce: 'n4', client: 'agent', agentChallenge: 'chal', agentCallbackScheme: 'evil', kind: 'lark_login' },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256' },
    );
    expect(() => verifyLoginState(bad)).toThrow(/malformed/);
  });

  it('rejects a forged login state', () => {
    const forged = jwt.sign({ nonce: 'x', client: 'dashboard', kind: 'lark_login' }, 'another-secret-32-chars-long-xxxx', {
      algorithm: 'HS256',
    });
    expect(() => verifyLoginState(forged)).toThrow();
  });

  it('rejects a connect-state token replayed as a login state (wrong kind)', () => {
    const connect = signOAuthState('user_1'); // kind: lark_oauth
    expect(() => verifyLoginState(connect)).toThrow(/malformed/);
  });

  it('rejects an unknown client', () => {
    const bad = jwt.sign({ nonce: 'x', client: 'mobile', kind: 'lark_login' }, process.env.JWT_SECRET!, {
      algorithm: 'HS256',
    });
    expect(() => verifyLoginState(bad)).toThrow(/malformed/);
  });

  it('rejects an expired login state', () => {
    const expired = jwt.sign({ nonce: 'x', client: 'dashboard', kind: 'lark_login' }, process.env.JWT_SECRET!, {
      algorithm: 'HS256',
      expiresIn: -10,
    });
    expect(() => verifyLoginState(expired)).toThrow();
  });

  it('recovers only a signed expired agent routing hint', () => {
    const expired = jwt.sign(
      { nonce: 'n5', client: 'agent', agentChallenge: 'chal', agentCallbackScheme: 'timo', kind: 'lark_login' },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: -10 },
    );
    expect(verifyExpiredAgentLoginRouteHint(expired)).toEqual({
      client: 'agent',
      agentCallbackScheme: 'timo',
    });
  });

  it('does not recover dashboard or forged login state route hints', () => {
    const dashboard = jwt.sign({ nonce: 'n6', client: 'dashboard', kind: 'lark_login' }, process.env.JWT_SECRET!, {
      algorithm: 'HS256',
      expiresIn: -10,
    });
    const forged = jwt.sign(
      { nonce: 'n7', client: 'agent', agentCallbackScheme: 'timo', kind: 'lark_login' },
      'another-secret-32-chars-long-xxxx',
      { algorithm: 'HS256', expiresIn: -10 },
    );

    expect(verifyExpiredAgentLoginRouteHint(dashboard)).toBeNull();
    expect(verifyExpiredAgentLoginRouteHint(forged)).toBeNull();
    expect(verifyExpiredAgentLoginRouteHint('not-a-jwt')).toBeNull();
  });
});
