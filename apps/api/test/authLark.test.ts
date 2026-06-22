import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { prisma } from '@grind/db';

// Configure Lark + provisioning BEFORE app/env first import.
process.env.LARK_APP_ID = 'cli_test';
process.env.LARK_APP_SECRET = 'secret';
process.env.LARK_TOKEN_KEY = crypto.randomBytes(32).toString('base64');
process.env.LARK_OAUTH_REDIRECT_URI = 'http://localhost:4000/v1/auth/lark/callback';
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
function configure(opts: { exchange?: () => Promise<Tokens>; profile?: Profile | null }) {
  const exchange = opts.exchange ?? (async () => TOKENS);
  const tm = new lark.TokenManager({
    prisma,
    client: { exchangeCode: exchange, refresh: async () => { throw new Error('no'); } },
    tokenKey: process.env.LARK_TOKEN_KEY!,
  });
  lark.setTokenManagerForTests(tm);
  const profile = opts.profile === undefined ? { openId: 'ou_1', unionId: null, name: 'Boss', email: 'boss@co.com', avatarUrl: null } : opts.profile;
  lark.setProfileClientForTests({ getProfile: async () => profile });
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
    expect(loc.searchParams.get('scope')).toContain('contact:user.email:readonly');
    expect(res.headers['set-cookie'].join(';')).toContain('grind_login_state=');
  });

  it('rejects an agent start with no code_challenge', async () => {
    const res = await request(app).get('/v1/auth/lark/start?client=agent');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('grind://auth?error=invalid_request');
  });
});

describe('GET /v1/auth/lark/callback — dashboard', () => {
  it('issues a session for a bootstrap admin (ACTIVE) and redirects home', async () => {
    configure({});
    const state = lark.signLoginState({ nonce: 'n1', client: 'dashboard' });
    const res = await callback(state, { code: 'abc' }, 'n1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://dash.example/');
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
  async function getAgentCode(challenge: string): Promise<string> {
    configure({});
    const state = lark.signLoginState({ nonce: 'na', client: 'agent', agentChallenge: challenge });
    const res = await callback(state, { code: 'abc' });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.protocol).toBe('grind:');
    const code = url.searchParams.get('code');
    expect(code).toBeTruthy();
    return code!;
  }

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
