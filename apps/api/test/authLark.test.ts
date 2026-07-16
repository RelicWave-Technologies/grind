import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@grind/db';
import { seedUser } from './helpers';

// Configure Lark + provisioning BEFORE app/env first import.
process.env.LARK_APP_ID = 'cli_test';
process.env.LARK_APP_SECRET = 'secret';
process.env.LARK_TOKEN_KEY = crypto.randomBytes(32).toString('base64');
process.env.LARK_LOGIN_REDIRECT_URI = 'http://localhost:4000/v1/auth/lark/callback';
process.env.LARK_CONNECT_REDIRECT_URI = 'http://localhost:4000/v1/lark/oauth/callback';
process.env.LARK_OAUTH_REDIRECT_URI = 'http://localhost:4000/legacy/should-not-be-used';
process.env.LARK_ACCOUNTS_HOST = 'https://accounts.larksuite.com';
process.env.DASHBOARD_URL = 'https://dash.example';
process.env.LARK_BOOTSTRAP_ADMIN_EMAILS = 'boss@co.com';
process.env.WORKSPACE_ID = 'ws_test';

const { buildApp } = await import('../src/app');
const lark = await import('../src/lark');
const { LarkTransientError } = lark;

const app = buildApp();

type Tokens = {
  accessToken: string;
  accessExpiresInSec: number;
  refreshToken: string;
  refreshExpiresInSec: number;
  scope: string;
};
const TOKENS: Tokens = {
  accessToken: 'at',
  accessExpiresInSec: 7200,
  refreshToken: 'rt',
  refreshExpiresInSec: 604800,
  scope: lark.LARK_SCOPE_STRING,
};

type Profile = { openId: string; unionId: string | null; name: string; email: string | null; avatarUrl: string | null };

/** Inject a TokenManager around a fake OAuth client + a fake profile client. */
function configure(opts: { exchange?: (code: string, redirectUri: string) => Promise<Tokens>; profile?: Profile | null }) {
  const exchange = opts.exchange ?? (async () => TOKENS);
  const tm = new lark.TokenManager({
    prisma,
    client: { exchangeCode: exchange, refresh: async () => { throw new Error('no'); } },
    tokenKey: process.env.LARK_TOKEN_KEY!,
  });
  lark.setTokenManagerForTests(tm);
  const profile = opts.profile === undefined ? { openId: 'ou_1', unionId: null, name: 'Boss', email: 'boss@co.com', avatarUrl: null } : opts.profile;
  lark.setProfileClientForTests({ getProfile: async () => profile });
  return tm;
}

beforeEach(() => {
  lark.setTokenManagerForTests(null);
  lark.setProfileClientForTests(null);
});

function callback(state: string, query: Record<string, string>, cookieNonce?: string) {
  const qs = new URLSearchParams({ state, ...query }).toString();
  const req = request(app).get(`/v1/auth/lark/callback?${qs}`);
  if (cookieNonce) req.set('Cookie', `grind_login_state=${cookieNonce}`);
  return req;
}

describe('GET /v1/auth/lark/start', () => {
  it('redirects to the Lark authorize URL and sets a state cookie (dashboard)', async () => {
    const res = await request(app).get('/v1/auth/lark/start');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin).toBe('https://accounts.larksuite.com');
    expect(loc.searchParams.get('client_id')).toBe('cli_test');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost:4000/v1/auth/lark/callback');
    expect(loc.searchParams.get('scope')).toContain('contact:user.email:readonly');
    expect(res.headers['set-cookie'].join(';')).toContain('grind_login_state=');
  });

  it('rejects an agent start with no code_challenge', async () => {
    const res = await request(app).get('/v1/auth/lark/start?client=agent');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('grind://auth?error=invalid_request');
  });

  it('uses the requested Timo callback scheme for agent start errors', async () => {
    const res = await request(app).get('/v1/auth/lark/start?client=agent&callback_scheme=timo');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('timo://auth?error=invalid_request');
  });
});

describe('GET /v1/auth/lark/callback — dashboard', () => {
  it('issues a session for a bootstrap admin (ACTIVE) and redirects home', async () => {
    let exchangedRedirectUri: string | null = null;
    configure({
      exchange: async (_code, redirectUri) => {
        exchangedRedirectUri = redirectUri;
        return TOKENS;
      },
    });
    const state = lark.signLoginState({ nonce: 'n1', client: 'dashboard' });
    const res = await callback(state, { code: 'abc' }, 'n1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://dash.example/');
    expect(exchangedRedirectUri).toBe('http://localhost:4000/v1/auth/lark/callback');
    expect(res.headers['set-cookie'].join(';')).toContain('grind_at=');
    const u = await prisma.user.findFirst();
    expect(u?.role).toBe('ADMIN');
    expect(u?.provisioningStatus).toBe('ACTIVE');
    // Lark refresh token was persisted.
    expect(await prisma.larkOAuthToken.count()).toBe(1);
  });

  it('routes a non-bootstrap user to pending (no session)', async () => {
    // Seed a prior user so the newcomer isn't the first (first user → admin).
    const ws = await prisma.workspace.create({ data: { id: 'ws_test', name: 'W' } });
    await prisma.user.create({ data: { workspaceId: ws.id, email: 'existing@co.com', name: 'X', role: 'ADMIN', provisioningStatus: 'ACTIVE' } });
    configure({ profile: { openId: 'ou_x', unionId: null, name: 'Newbie', email: 'newbie@co.com', avatarUrl: null } });
    const state = lark.signLoginState({ nonce: 'n2', client: 'dashboard' });
    const res = await callback(state, { code: 'abc' }, 'n2');
    expect(res.headers.location).toBe('https://dash.example/login?status=pending');
    // No session cookie for a pending user (the state cookie is cleared, that's fine).
    expect((res.headers['set-cookie'] ?? []).join(';')).not.toContain('grind_at=');
    const u = await prisma.user.findUnique({ where: { email: 'newbie@co.com' } });
    expect(u?.provisioningStatus).toBe('PENDING');
  });

  it('preserves a safe dashboard next path through the signed state', async () => {
    configure({});
    const start = await request(app).get('/v1/auth/lark/start?client=dashboard&next=%2Fedit-time%3Fdate%3D2026-07-16');
    const loc = new URL(start.headers.location);
    const state = loc.searchParams.get('state');
    expect(state).toBeTruthy();

    const payload = lark.verifyLoginState(state!);
    expect(payload.nextPath).toBe('/edit-time?date=2026-07-16');

    const res = await callback(state!, { code: 'abc' }, payload.nonce);
    expect(res.headers.location).toBe('https://dash.example/edit-time?date=2026-07-16');
  });

  it('drops unsafe dashboard next paths', async () => {
    const start = await request(app).get('/v1/auth/lark/start?client=dashboard&next=https%3A%2F%2Fevil.example');
    const loc = new URL(start.headers.location);
    const state = loc.searchParams.get('state');
    expect(state).toBeTruthy();

    const payload = lark.verifyLoginState(state!);
    expect(payload.nextPath).toBeUndefined();
  });

  it('rejects a CSRF cookie/state mismatch', async () => {
    configure({});
    const state = lark.signLoginState({ nonce: 'n3', client: 'dashboard' });
    const res = await callback(state, { code: 'abc' }, 'WRONG');
    expect(res.headers.location).toBe('https://dash.example/login?error=state_invalid');
  });

  it('rejects a forged/garbage state', async () => {
    const res = await callback('not-a-jwt', { code: 'abc' }, 'n');
    expect(res.headers.location).toBe('https://dash.example/login?error=state_invalid');
  });

  it('maps user-denied consent to ?error=denied', async () => {
    const state = lark.signLoginState({ nonce: 'n4', client: 'dashboard' });
    const res = await callback(state, { error: 'access_denied' }, 'n4');
    expect(res.headers.location).toBe('https://dash.example/login?error=denied');
  });

  it('maps a transient exchange failure to ?error=temporary', async () => {
    configure({ exchange: async () => { throw new LarkTransientError(); } });
    const state = lark.signLoginState({ nonce: 'n5', client: 'dashboard' });
    const res = await callback(state, { code: 'abc' }, 'n5');
    expect(res.headers.location).toBe('https://dash.example/login?error=temporary');
  });

  it('maps a missing email to ?error=no_email', async () => {
    configure({ profile: { openId: 'ou_n', unionId: null, name: 'NoMail', email: null, avatarUrl: null } });
    const state = lark.signLoginState({ nonce: 'n6', client: 'dashboard' });
    const res = await callback(state, { code: 'abc' }, 'n6');
    expect(res.headers.location).toBe('https://dash.example/login?error=no_email');
  });
});

describe('agent deep-link + exchange', () => {
  async function getAgentCode(challenge: string, callbackScheme: 'grind' | 'timo' = 'grind'): Promise<string> {
    configure({});
    const state = lark.signLoginState({
      nonce: 'na',
      client: 'agent',
      agentChallenge: challenge,
      agentCallbackScheme: callbackScheme,
    });
    const res = await callback(state, { code: 'abc' });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.protocol).toBe(`${callbackScheme}:`);
    const code = url.searchParams.get('code');
    expect(code).toBeTruthy();
    return code!;
  }

  it('routes new Timo agents through timo://', async () => {
    const verifier = crypto.randomBytes(40).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const code = await getAgentCode(challenge, 'timo');

    const res = await request(app).post('/v1/auth/lark/exchange').send({ code, codeVerifier: verifier });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('routes an expired but signed Timo agent state back to the agent', async () => {
    const expired = jwt.sign(
      {
        nonce: 'expired-agent',
        client: 'agent',
        agentChallenge: 'chal',
        agentCallbackScheme: 'timo',
        kind: 'lark_login',
      },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: -10 },
    );

    const res = await callback(expired, { code: 'abc' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('timo://auth?error=state_invalid');
  });

  it('issues a one-time code and exchanges it for a session', async () => {
    const verifier = crypto.randomBytes(40).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const code = await getAgentCode(challenge);

    const res = await request(app).post('/v1/auth/lark/exchange').send({ code, codeVerifier: verifier });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.workspaceId).toBe('ws_test');
  });

  it('rejects the one-time code with a wrong verifier (PKCE)', async () => {
    const verifier = crypto.randomBytes(40).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const code = await getAgentCode(challenge);

    const res = await request(app).post('/v1/auth/lark/exchange').send({ code, codeVerifier: crypto.randomBytes(40).toString('base64url') });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('pkce_mismatch');
  });

  it('rejects reuse of a one-time code', async () => {
    const verifier = crypto.randomBytes(40).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const code = await getAgentCode(challenge);
    await request(app).post('/v1/auth/lark/exchange').send({ code, codeVerifier: verifier });
    const res = await request(app).post('/v1/auth/lark/exchange').send({ code, codeVerifier: verifier });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('code_invalid');
  });
});

describe('GET /v1/lark/status — proactive refresh', () => {
  function statusManager(opts: { refresh?: () => Promise<Tokens> }) {
    let nowMs = 1_700_000_000_000;
    let refreshCalls = 0;
    const tm = new lark.TokenManager({
      prisma,
      tokenKey: process.env.LARK_TOKEN_KEY!,
      now: () => nowMs,
      client: {
        exchangeCode: async () => TOKENS,
        refresh: async () => {
          refreshCalls += 1;
          return opts.refresh ? opts.refresh() : { ...TOKENS, accessToken: 'at_refreshed', refreshToken: 'rt_refreshed' };
        },
      },
    });
    lark.setTokenManagerForTests(tm);
    return {
      tm,
      advance(ms: number) {
        nowMs += ms;
      },
      refreshCalls() {
        return refreshCalls;
      },
    };
  }

  it('best-effort refreshes a due grant and still reports connected', async () => {
    const { userId, accessToken } = await seedUser();
    const h = statusManager({});
    await h.tm.persistTokens(userId, TOKENS);
    h.advance(6 * 24 * 3600 * 1000 + 2 * 3600 * 1000);

    const res = await request(app).get('/v1/lark/status').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.reauthRequired).toBe(false);
    expect(h.refreshCalls()).toBe(1);
  });

  it('does not force reconnect when due refresh is transient', async () => {
    const { userId, accessToken } = await seedUser();
    const h = statusManager({ refresh: async () => { throw new LarkTransientError('lark 503'); } });
    await h.tm.persistTokens(userId, TOKENS);
    h.advance(6 * 24 * 3600 * 1000 + 2 * 3600 * 1000);

    const res = await request(app).get('/v1/lark/status').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.reauthRequired).toBe(false);
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(row!.reauthRequired).toBe(false);
  });

  it('reports reauth when due refresh is explicitly rejected', async () => {
    const { userId, accessToken } = await seedUser();
    const h = statusManager({ refresh: async () => { throw new lark.LarkReauthRequiredError('revoked'); } });
    await h.tm.persistTokens(userId, TOKENS);
    h.advance(6 * 24 * 3600 * 1000 + 2 * 3600 * 1000);

    const res = await request(app).get('/v1/lark/status').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.reauthRequired).toBe(true);
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(row!.reauthRequired).toBe(true);
  });
});
