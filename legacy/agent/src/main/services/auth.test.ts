import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  api: vi.fn(),
  loadPendingLarkLogin: vi.fn(),
  savePendingLarkLogin: vi.fn(),
  clearStoredPendingLarkLogin: vi.fn(),
  saveTokens: vi.fn(),
  loadTokens: vi.fn(),
  clearTokens: vi.fn(),
  clearWorkspaceTimeSession: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
}));

vi.mock('./apiClient', () => {
  class UnauthorizedError extends Error {}
  return {
    api: mocks.api,
    UnauthorizedError,
  };
});

vi.mock('./tokenStore', () => ({
  saveTokens: mocks.saveTokens,
  loadTokens: mocks.loadTokens,
  clearTokens: mocks.clearTokens,
}));

vi.mock('./pendingLarkLoginStore', () => ({
  loadPendingLarkLogin: mocks.loadPendingLarkLogin,
  savePendingLarkLogin: mocks.savePendingLarkLogin,
  clearStoredPendingLarkLogin: mocks.clearStoredPendingLarkLogin,
}));

vi.mock('./workspaceTime', () => ({
  clearWorkspaceTimeSession: mocks.clearWorkspaceTimeSession,
}));

vi.mock('../logger', () => ({
  log: { warn: mocks.warn },
}));

import {
  LARK_LOGIN_HARD_TTL_MS,
  LARK_LOGIN_REUSE_TTL_MS,
  cancelLarkLogin,
  completeLarkLogin,
  startLarkLogin,
} from './auth';

const BASE_TIME = new Date('2026-07-03T00:00:00.000Z');

function openedUrl(call = 0): URL {
  return new URL(mocks.openExternal.mock.calls[call]![0] as string);
}

describe('Lark agent login flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.api.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      userId: 'user_1',
      workspaceId: 'ws_1',
    });
    mocks.saveTokens.mockResolvedValue(undefined);
    mocks.loadPendingLarkLogin.mockResolvedValue(null);
    mocks.savePendingLarkLogin.mockResolvedValue(undefined);
    mocks.clearStoredPendingLarkLogin.mockResolvedValue(undefined);
    mocks.loadTokens.mockResolvedValue(null);
    mocks.clearWorkspaceTimeSession.mockReset();
    cancelLarkLogin();
  });

  afterEach(() => {
    cancelLarkLogin();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('opens a Lark login URL with the agent client, callback scheme, and PKCE challenge', async () => {
    await startLarkLogin();

    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    const url = openedUrl();
    expect(url.origin).toBe('http://localhost:4000');
    expect(url.pathname).toBe('/v1/auth/lark/start');
    expect(url.searchParams.get('client')).toBe('agent');
    expect(url.searchParams.get('callback_scheme')).toBe('timo');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mocks.savePendingLarkLogin).toHaveBeenCalledWith({
      verifier: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/),
      loginUrl: url.toString(),
      createdAt: BASE_TIME.getTime(),
    });
  });

  it('reuses a pending login URL before the reuse TTL', async () => {
    await startLarkLogin();
    const first = openedUrl().toString();

    vi.setSystemTime(BASE_TIME.getTime() + LARK_LOGIN_REUSE_TTL_MS - 1);
    await startLarkLogin();

    expect(mocks.openExternal).toHaveBeenCalledTimes(2);
    expect(openedUrl(1).toString()).toBe(first);
  });

  it('regenerates the login URL once the reuse TTL has elapsed', async () => {
    await startLarkLogin();
    const firstChallenge = openedUrl().searchParams.get('code_challenge');

    vi.setSystemTime(BASE_TIME.getTime() + LARK_LOGIN_REUSE_TTL_MS);
    await startLarkLogin();

    expect(mocks.openExternal).toHaveBeenCalledTimes(2);
    expect(openedUrl(1).searchParams.get('code_challenge')).not.toBe(firstChallenge);
  });

  it('does not redeem a hard-expired pending verifier', async () => {
    await startLarkLogin();
    vi.setSystemTime(BASE_TIME.getTime() + LARK_LOGIN_HARD_TTL_MS);

    await expect(completeLarkLogin('agent-code')).resolves.toBe(false);

    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.saveTokens).not.toHaveBeenCalled();
  });

  it('clears pending state when the browser cannot be opened', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error('boom'));
    await expect(startLarkLogin()).rejects.toThrow('boom');
    const failedChallenge = openedUrl().searchParams.get('code_challenge');

    mocks.openExternal.mockResolvedValue(undefined);
    await startLarkLogin();

    expect(openedUrl(1).searchParams.get('code_challenge')).not.toBe(failedChallenge);
  });

  it('clears pending state when login is cancelled', async () => {
    await startLarkLogin();
    const firstChallenge = openedUrl().searchParams.get('code_challenge');

    cancelLarkLogin();
    await startLarkLogin();

    expect(openedUrl(1).searchParams.get('code_challenge')).not.toBe(firstChallenge);
  });

  it('redeems a non-expired deep-link code with the pending verifier and stores tokens', async () => {
    await startLarkLogin();
    const ok = await completeLarkLogin('agent-code');

    expect(ok).toBe(true);
    expect(mocks.api).toHaveBeenCalledWith('/v1/auth/lark/exchange', {
      method: 'POST',
      auth: false,
      body: {
        code: 'agent-code',
        codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{64}$/),
      },
    });
    expect(mocks.saveTokens).toHaveBeenCalledWith({
      accessToken: 'at',
      refreshToken: 'rt',
      userId: 'user_1',
      workspaceId: 'ws_1',
    });
    expect(mocks.clearStoredPendingLarkLogin).toHaveBeenCalled();
    expect(mocks.clearWorkspaceTimeSession).toHaveBeenCalledTimes(1);
  });

  it('redeems a deep-link code after app relaunch by hydrating the stored verifier', async () => {
    await startLarkLogin();
    const stored = mocks.savePendingLarkLogin.mock.calls[0]![0];

    vi.resetModules();
    mocks.loadPendingLarkLogin.mockResolvedValueOnce(stored);
    const fresh = await import('./auth');
    const ok = await fresh.completeLarkLogin('agent-code');

    expect(ok).toBe(true);
    expect(mocks.api).toHaveBeenCalledWith('/v1/auth/lark/exchange', {
      method: 'POST',
      auth: false,
      body: {
        code: 'agent-code',
        codeVerifier: stored.verifier,
      },
    });
  });
});
