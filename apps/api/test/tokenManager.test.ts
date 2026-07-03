import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@grind/db';
import { TokenManager } from '../src/lark/tokenManager';
import {
  type OAuthClient,
  type LarkTokenResponse,
  LarkReauthRequiredError,
  LarkTransientError,
} from '../src/lark/oauthClient';
import { decryptToken } from '../src/lark/crypto';
import { LARK_SCOPE_STRING } from '../src/lark/config';
import { seedUser } from './helpers';

const KEY = crypto.randomBytes(32).toString('base64');

/**
 * Fake Lark OAuth server that enforces SINGLE-USE refresh tokens: each refresh
 * mints a new token and invalidates the prior one, exactly like Lark v2. This
 * is what lets us prove the rotation invariants without a network.
 */
class FakeOAuth implements OAuthClient {
  private valid = new Set<string>();
  private seq = 0;
  refreshCalls = 0;
  exchangeCalls = 0;
  accessExpiresInSec = 7200;
  refreshExpiresInSec = 60 * 60 * 24 * 7;
  failRefreshWith: Error | null = null;
  refreshDelay: Promise<void> | null = null;
  scope = LARK_SCOPE_STRING;

  private mint(): LarkTokenResponse {
    this.seq += 1;
    const refreshToken = `rt_${this.seq}`;
    this.valid.add(refreshToken);
    return {
      accessToken: `at_${this.seq}`,
      accessExpiresInSec: this.accessExpiresInSec,
      refreshToken,
      refreshExpiresInSec: this.refreshExpiresInSec,
      scope: this.scope,
    };
  }

  async exchangeCode(): Promise<LarkTokenResponse> {
    this.exchangeCalls += 1;
    return this.mint();
  }

  async refresh(refreshToken: string): Promise<LarkTokenResponse> {
    this.refreshCalls += 1;
    if (this.refreshDelay) await this.refreshDelay;
    if (this.failRefreshWith) throw this.failRefreshWith;
    if (!this.valid.has(refreshToken)) {
      throw new LarkReauthRequiredError('refresh token already used or unknown');
    }
    this.valid.delete(refreshToken); // single-use
    return this.mint();
  }
}

let client: FakeOAuth;
let userId: string;
let nowMs: number;
const now = () => nowMs;

function makeManager() {
  return new TokenManager({ prisma, client, tokenKey: KEY, now });
}

beforeEach(async () => {
  client = new FakeOAuth();
  nowMs = 1_700_000_000_000;
  const u = await seedUser();
  userId = u.userId;
});

describe('TokenManager.connect', () => {
  it('exchanges the code and stores an encrypted refresh token', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'auth-code', 'https://app/redirect');
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(row).not.toBeNull();
    expect(row!.reauthRequired).toBe(false);
    // stored ciphertext is not the plaintext, and decrypts back to a real token
    expect(row!.refreshTokenEnc).not.toContain('rt_');
    expect(decryptToken(row!.refreshTokenEnc, KEY)).toBe('rt_1');
  });

  it('returns the cached access token without burning a refresh', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    const at = await tm.getAccessToken(userId);
    expect(at).toBe('at_1');
    expect(client.refreshCalls).toBe(0); // served from cache
  });

  it('keeps the cached access token when the refresh grant is not due', async () => {
    client.accessExpiresInSec = 10 * 24 * 3600;
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');

    nowMs += 2 * 3600 * 1000;
    const at = await tm.getAccessToken(userId);

    expect(at).toBe('at_1');
    expect(client.refreshCalls).toBe(0);
  });

  it('refreshes a due grant even when the cached access token is still valid', async () => {
    client.accessExpiresInSec = 10 * 24 * 3600;
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');

    nowMs += 6 * 24 * 3600 * 1000 + 2 * 3600 * 1000; // inside the final 24h grant window
    const at = await tm.getAccessToken(userId);

    expect(at).toBe('at_2');
    expect(client.refreshCalls).toBe(1);
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(decryptToken(row!.refreshTokenEnc, KEY)).toBe('rt_2');
  });
});

describe('TokenManager.getAccessToken rotation', () => {
  it('rotates the single-use refresh token and persists the new one BEFORE returning', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    // expire the cached access token
    nowMs += 3 * 3600 * 1000;

    const at = await tm.getAccessToken(userId);
    expect(at).toBe('at_2');
    expect(client.refreshCalls).toBe(1);
    // the rotated refresh token is what's persisted (rt_2), old one gone
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(decryptToken(row!.refreshTokenEnc, KEY)).toBe('rt_2');
    expect(row!.lastRefreshedAt).not.toBeNull();
  });

  it('does not double-spend the refresh token under concurrent callers', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    nowMs += 3 * 3600 * 1000; // force refresh

    const [a, b, c] = await Promise.all([
      tm.getAccessToken(userId),
      tm.getAccessToken(userId),
      tm.getAccessToken(userId),
    ]);
    // serialized: exactly one refresh, all three see the same fresh token
    expect(client.refreshCalls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('does not double-refresh proactive grant rotation across TokenManager instances', async () => {
    const tm1 = makeManager();
    const tm2 = makeManager();
    await tm1.connect(userId, 'code', 'r');
    nowMs += 6 * 24 * 3600 * 1000 + 2 * 3600 * 1000; // force proactive grant refresh

    const [a, b] = await Promise.all([tm1.refreshGrantIfDue(userId), tm2.refreshGrantIfDue(userId)]);

    expect([a, b].sort()).toEqual(['refreshed', 'skipped']);
    expect(client.refreshCalls).toBe(1);
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(decryptToken(row!.refreshTokenEnc, KEY)).toBe('rt_2');
  });

  it('survives repeated rotations (token stays usable across many refreshes)', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    for (let i = 0; i < 5; i++) {
      nowMs += 3 * 3600 * 1000;
      await tm.getAccessToken(userId);
    }
    expect(client.refreshCalls).toBe(5);
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(row!.reauthRequired).toBe(false);
    expect(decryptToken(row!.refreshTokenEnc, KEY)).toBe('rt_6');
  });
});

describe('TokenManager failure handling → reauthRequired', () => {
  it('flags reauth when Lark rejects the refresh token', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    nowMs += 3 * 3600 * 1000;
    client.failRefreshWith = new LarkReauthRequiredError('revoked');

    await expect(tm.getAccessToken(userId)).rejects.toBeInstanceOf(LarkReauthRequiredError);
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(row!.reauthRequired).toBe(true);
  });

  it('does NOT force reconnect on a transient refresh failure (stays connected, retries later)', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    nowMs += 3 * 3600 * 1000; // force a refresh
    // A network blip / Lark 5xx — the single-use token was NOT consumed.
    client.failRefreshWith = new LarkTransientError('lark 503');

    await expect(tm.getAccessToken(userId)).rejects.toBeInstanceOf(LarkTransientError);
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(row!.reauthRequired).toBe(false); // still connected — no forced re-login

    // Once the blip clears, the SAME (unburned) refresh token works.
    client.failRefreshWith = null;
    const at = await tm.getAccessToken(userId);
    expect(at).toBe('at_2');
    expect((await tm.getStatus(userId)).connected).toBe(true);
  });

  it('cleans up the per-user lock after a refresh failure', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    nowMs += 3 * 3600 * 1000;
    client.failRefreshWith = new LarkTransientError('lark 503');

    await expect(tm.getAccessToken(userId)).rejects.toBeInstanceOf(LarkTransientError);

    client.failRefreshWith = null;
    await expect(tm.getAccessToken(userId)).resolves.toBe('at_2');
    expect(client.refreshCalls).toBe(2);
  });

  it('flags reauth when the stored refresh token has expired', async () => {
    const tm = makeManager();
    client.accessExpiresInSec = 30; // cached access also expires fast
    client.refreshExpiresInSec = 60; // refresh expires fast
    await tm.connect(userId, 'code', 'r');
    nowMs += 120_000; // past both access and refresh expiry

    await expect(tm.getAccessToken(userId)).rejects.toThrow(/expired/);
    expect(client.refreshCalls).toBe(0); // never even attempted
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(row!.reauthRequired).toBe(true);
  });

  it('throws reauth when the user never connected', async () => {
    const tm = makeManager();
    await expect(tm.getAccessToken(userId)).rejects.toBeInstanceOf(LarkReauthRequiredError);
  });

  it('refuses once reauthRequired is set, until reconnect', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    await prisma.larkOAuthToken.update({ where: { userId }, data: { reauthRequired: true } });
    nowMs += 3 * 3600 * 1000;

    await expect(tm.getAccessToken(userId)).rejects.toBeInstanceOf(LarkReauthRequiredError);
    // reconnect clears the flag and works again
    await tm.connect(userId, 'code2', 'r');
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(row!.reauthRequired).toBe(false);
  });

  it('flags reauth if the stored ciphertext cannot be decrypted (key rotated)', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    nowMs += 3 * 3600 * 1000;
    // simulate a key change: corrupt the stored ciphertext
    await prisma.larkOAuthToken.update({
      where: { userId },
      data: { refreshTokenEnc: 'garbage.garbage.garbage' },
    });
    await expect(tm.getAccessToken(userId)).rejects.toThrow(/decrypt/);
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(row!.reauthRequired).toBe(true);
  });
});

describe('TokenManager.getStatus / disconnect', () => {
  it('reports not-connected before connect', async () => {
    const tm = makeManager();
    const s = await tm.getStatus(userId);
    expect(s).toMatchObject({ connected: false, reauthRequired: false, scopes: [] });
  });

  it('reports connected with scopes after connect', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    const s = await tm.getStatus(userId);
    expect(s.connected).toBe(true);
    expect(s.scopes).toContain('offline_access');
    expect(s.refreshExpiresAt).toBeInstanceOf(Date);
  });

  it('requires reconnect when the stored grant is missing a required scope', async () => {
    client.scope = 'task:task:read offline_access';
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');

    const s = await tm.getStatus(userId);
    expect(s.connected).toBe(false);
    expect(s.reauthRequired).toBe(true);
    expect(s.missingScopes).toContain('task:task:write');

    nowMs += 3 * 3600 * 1000;
    await expect(tm.getAccessToken(userId)).rejects.toBeInstanceOf(LarkReauthRequiredError);
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(row!.reauthRequired).toBe(true);
  });

  it('reports reauthRequired when the refresh token is past expiry', async () => {
    const tm = makeManager();
    client.refreshExpiresInSec = 60;
    await tm.connect(userId, 'code', 'r');
    nowMs += 120_000;
    const s = await tm.getStatus(userId);
    expect(s.connected).toBe(false);
    expect(s.reauthRequired).toBe(true);
  });

  it('disconnect forgets the tokens', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    await tm.disconnect(userId);
    expect(await prisma.larkOAuthToken.findUnique({ where: { userId } })).toBeNull();
    const s = await tm.getStatus(userId);
    expect(s.connected).toBe(false);
  });
});
