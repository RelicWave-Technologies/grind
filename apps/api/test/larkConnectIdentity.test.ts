import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { prisma } from '@grind/db';
import { buildApp } from '../src/app';
import * as lark from '../src/lark';
import { seedUser } from './helpers';

/**
 * The task-connect callback must only store tokens for the Lark account that
 * belongs to the Timo user who started the flow. A forwarded or swapped
 * authorize link otherwise binds someone else's Lark account to this user.
 */

const app = buildApp();

const TOKENS = {
  accessToken: 'at-connect',
  accessExpiresInSec: 7200,
  refreshToken: 'rt-connect',
  refreshExpiresInSec: 604800,
  scope: lark.LARK_SCOPE_STRING,
};

type Profile = { openId: string; unionId: string | null; name: string; email: string | null; avatarUrl: string | null };

function configure(profile: Profile | null) {
  lark.setTokenManagerForTests(new lark.TokenManager({
    prisma,
    client: { exchangeCode: async () => TOKENS, refresh: async () => { throw new Error('no'); } },
    tokenKey: process.env.LARK_TOKEN_KEY!,
  }));
  lark.setProfileClientForTests({ getProfile: async () => profile });
}

beforeEach(() => {
  process.env.LARK_APP_ID = 'cli_test';
  process.env.LARK_APP_SECRET = 'secret';
  process.env.LARK_TOKEN_KEY = crypto.randomBytes(32).toString('base64');
  // Unreachable on purpose: the best-effort tenant identity lookup after a
  // successful connect must fail fast instead of reaching the real Lark.
  process.env.LARK_OAUTH_HOST = 'http://127.0.0.1:9';
  process.env.LARK_CONNECT_REDIRECT_URI = 'http://localhost:4000/v1/lark/oauth/callback';
});

afterEach(() => {
  lark.setTokenManagerForTests(null);
  lark.setProfileClientForTests(null);
  for (const key of ['LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_TOKEN_KEY', 'LARK_OAUTH_HOST', 'LARK_CONNECT_REDIRECT_URI']) {
    delete process.env[key];
  }
});

function callback(userId: string, returnTo: 'browser' | 'agent' = 'browser') {
  const state = lark.signOAuthState(userId, returnTo === 'agent' ? { returnTo, agentCallbackScheme: 'timo' } : {});
  return request(app).get(`/v1/lark/oauth/callback?${new URLSearchParams({ code: 'c', state })}`);
}

async function emailOf(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  return u.email;
}

describe('GET /v1/lark/oauth/callback — identity check', () => {
  it('stores tokens when the Lark email is the signed-in user (no identity linked yet)', async () => {
    const { userId } = await seedUser();
    configure({ openId: `ou_${userId}`, unionId: null, name: 'Me', email: (await emailOf(userId)).toUpperCase(), avatarUrl: null });
    const res = await callback(userId);
    expect(res.status).toBe(200);
    expect(await prisma.larkOAuthToken.count({ where: { userId } })).toBe(1);
  });

  it('rejects a different person’s Lark account and stores nothing', async () => {
    const { userId } = await seedUser();
    configure({ openId: `ou_other_${userId}`, unionId: null, name: 'Someone', email: 'someone-else@test.local', avatarUrl: null });
    const res = await callback(userId);
    expect(res.status).toBe(403);
    expect(res.text).toContain('Different Lark account');
    expect(await prisma.larkOAuthToken.count({ where: { userId } })).toBe(0);
  });

  it('tells the agent the connect failed on a wrong account', async () => {
    const { userId } = await seedUser();
    configure({ openId: `ou_other2_${userId}`, unionId: null, name: 'Someone', email: 'someone-else2@test.local', avatarUrl: null });
    const res = await callback(userId, 'agent');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('timo://lark?status=failed');
    expect(await prisma.larkOAuthToken.count({ where: { userId } })).toBe(0);
  });

  it('requires the linked open_id when the user already has a Lark identity', async () => {
    const { userId } = await seedUser();
    await prisma.larkIdentity.create({ data: { userId, openId: `ou_linked_${userId}` } });
    // Same email, different open_id: still not the linked account.
    configure({ openId: `ou_new_${userId}`, unionId: null, name: 'Me', email: await emailOf(userId), avatarUrl: null });
    const rejected = await callback(userId);
    expect(rejected.status).toBe(403);
    expect(await prisma.larkOAuthToken.count({ where: { userId } })).toBe(0);

    configure({ openId: `ou_linked_${userId}`, unionId: null, name: 'Me', email: null, avatarUrl: null });
    const accepted = await callback(userId);
    expect(accepted.status).toBe(200);
    expect(await prisma.larkOAuthToken.count({ where: { userId } })).toBe(1);
  });

  it('rejects an open_id that already belongs to another Timo user', async () => {
    const owner = await seedUser();
    const { userId } = await seedUser();
    await prisma.larkIdentity.create({ data: { userId: owner.userId, openId: `ou_owned_${owner.userId}` } });
    configure({ openId: `ou_owned_${owner.userId}`, unionId: null, name: 'Me', email: await emailOf(userId), avatarUrl: null });
    const res = await callback(userId);
    expect(res.status).toBe(403);
    expect(await prisma.larkOAuthToken.count({ where: { userId } })).toBe(0);
  });

  it('fails closed when Lark will not say who authorized', async () => {
    const { userId } = await seedUser();
    configure(null);
    const res = await callback(userId);
    expect(res.status).toBe(403);
    expect(await prisma.larkOAuthToken.count({ where: { userId } })).toBe(0);
  });
});
