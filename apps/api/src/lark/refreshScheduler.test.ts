import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@grind/db';
import { decryptToken } from './crypto';
import { LARK_SCOPE_STRING } from './config';
import type { LarkTokenResponse, OAuthClient } from './oauthClient';
import { TokenManager } from './tokenManager';
import { runLarkTokenRefreshOnce } from './refreshScheduler';

const KEY = crypto.randomBytes(32).toString('base64');
let seedCounter = 0;

class FakeOAuth implements OAuthClient {
  private valid = new Set<string>();
  private seq = 0;
  refreshCalls = 0;
  accessExpiresInSec = 7200;
  refreshExpiresInSec = 60 * 60 * 24 * 7;
  refreshDelay: Promise<void> | null = null;

  private mint(): LarkTokenResponse {
    this.seq += 1;
    const refreshToken = `rt_${this.seq}`;
    this.valid.add(refreshToken);
    return {
      accessToken: `at_${this.seq}`,
      accessExpiresInSec: this.accessExpiresInSec,
      refreshToken,
      refreshExpiresInSec: this.refreshExpiresInSec,
      scope: LARK_SCOPE_STRING,
    };
  }

  async exchangeCode(): Promise<LarkTokenResponse> {
    return this.mint();
  }

  async refresh(refreshToken: string): Promise<LarkTokenResponse> {
    this.refreshCalls += 1;
    if (this.refreshDelay) await this.refreshDelay;
    if (!this.valid.has(refreshToken)) throw new Error('refresh token already used');
    this.valid.delete(refreshToken);
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

async function seedRefreshUser(): Promise<string> {
  seedCounter += 1;
  const ws = await prisma.workspace.create({ data: { name: `Lark refresh ${seedCounter}` } });
  const user = await prisma.user.create({
    data: {
      workspaceId: ws.id,
      email: `lark-refresh-${seedCounter}-${Date.now()}@test.local`,
      name: `Lark Refresh ${seedCounter}`,
    },
  });
  return user.id;
}

describe('Lark token refresh scheduler', () => {
  beforeEach(async () => {
    client = new FakeOAuth();
    nowMs = 1_700_000_000_000;
    userId = await seedRefreshUser();
  });

  it('refreshes rows inside the proactive window', async () => {
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    nowMs += 6 * 24 * 3600 * 1000 + 2 * 3600 * 1000;

    const result = await runLarkTokenRefreshOnce(new Date(nowMs), tm);

    expect(result).toMatchObject({ checkedRows: 1, refreshedRows: 1 });
    expect(client.refreshCalls).toBe(1);
    const row = await prisma.larkOAuthToken.findUnique({ where: { userId } });
    expect(decryptToken(row!.refreshTokenEnc, KEY)).toBe('rt_2');
  });

  it('skips scanned rows outside their proactive window', async () => {
    client.refreshExpiresInSec = 3600;
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    nowMs += 30 * 60_000;

    const result = await runLarkTokenRefreshOnce(new Date(nowMs), tm);

    expect(result).toMatchObject({ checkedRows: 1, refreshedRows: 0, skippedRows: 1 });
    expect(client.refreshCalls).toBe(0);
  });

  it('is single-flight inside one process', async () => {
    let release!: () => void;
    client.refreshDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tm = makeManager();
    await tm.connect(userId, 'code', 'r');
    nowMs += 6 * 24 * 3600 * 1000 + 2 * 3600 * 1000;

    const first = runLarkTokenRefreshOnce(new Date(nowMs), tm);
    const second = runLarkTokenRefreshOnce(new Date(nowMs), tm);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.refreshedRows + b.refreshedRows).toBe(1);
    expect(a.checkedRows + b.checkedRows).toBe(1);
    expect(client.refreshCalls).toBe(1);
  });

  it('no-ops when Lark is unconfigured', async () => {
    const result = await runLarkTokenRefreshOnce(new Date(nowMs), null);

    expect(result.skippedUnconfigured).toBe(true);
    expect(result.checkedRows).toBe(0);
  });
});
