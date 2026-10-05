import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadTokens: vi.fn(),
  replaceTokensIfMatch: vi.fn(),
  clearTokensIfMatch: vi.fn(),
}));

vi.mock('./tokenStore', () => ({
  loadTokens: mocks.loadTokens,
  replaceTokensIfMatch: mocks.replaceTokensIfMatch,
  clearTokensIfMatch: mocks.clearTokensIfMatch,
}));
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { api, UnauthorizedError, HttpError, ApiNetworkError, onAuthChange, DEFAULT_TIMEOUT_MS } = await import('./apiClient');
const { setNetworkFetchForTests } = await import('./network');

const TOKENS = { accessToken: 'a0', refreshToken: 'r0', userId: 'u', workspaceId: 'w' };
const NEXT_TOKENS = { accessToken: 'a1', refreshToken: 'r1', userId: 'u', workspaceId: 'w' };

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setNetworkFetchForTests(null);
  mocks.loadTokens.mockReset();
  mocks.replaceTokensIfMatch.mockReset();
  mocks.replaceTokensIfMatch.mockResolvedValue(true);
  mocks.clearTokensIfMatch.mockReset();
  mocks.clearTokensIfMatch.mockResolvedValue(true);
});

describe('api() refresh handling', () => {
  it('keeps the session when refresh fails transiently (5xx)', async () => {
    mocks.loadTokens.mockResolvedValue(TOKENS);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(res(401, { error: 'expired' })).mockResolvedValueOnce(res(503, 'busy')),
    );
    const seen: string[] = [];
    const off = onAuthChange((s) => seen.push(s));

    await expect(api('/v1/thing')).rejects.toBeInstanceOf(HttpError);
    expect(mocks.clearTokensIfMatch).not.toHaveBeenCalled();
    expect(seen).not.toContain('loggedOut');
    off();
  });

  it('signs out only when refresh is definitively rejected (401)', async () => {
    mocks.loadTokens.mockResolvedValue(TOKENS);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(res(401, { error: 'expired' }))
        .mockResolvedValueOnce(res(401, { error: 'invalid_refresh' })),
    );
    const seen: string[] = [];
    const off = onAuthChange((s) => seen.push(s));

    await expect(api('/v1/thing')).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mocks.clearTokensIfMatch).toHaveBeenCalledOnce();
    expect(seen).toContain('loggedOut');
    off();
  });

  it('rotates on 401 then retries, returning the retried response', async () => {
    mocks.loadTokens.mockResolvedValue(TOKENS);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(res(401, { error: 'expired' }))
        .mockResolvedValueOnce(res(200, { accessToken: 'a1', refreshToken: 'r1' }))
        .mockResolvedValueOnce(res(200, { value: 42 })),
    );

    await expect(api<{ value: number }>('/v1/thing')).resolves.toEqual({ value: 42 });
    expect(mocks.replaceTokensIfMatch).toHaveBeenCalledWith(
      TOKENS,
      expect.objectContaining({ accessToken: 'a1', refreshToken: 'r1' }),
    );
  });

  it('uses newer stored tokens instead of refreshing a stale token', async () => {
    mocks.loadTokens.mockResolvedValueOnce(TOKENS).mockResolvedValueOnce(NEXT_TOKENS);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(401, { error: 'expired' }))
      .mockResolvedValueOnce(res(200, { value: 42 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api<{ value: number }>('/v1/thing')).resolves.toEqual({ value: 42 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1]?.headers).toMatchObject({ Authorization: 'Bearer a1' });
    expect(mocks.replaceTokensIfMatch).not.toHaveBeenCalled();
    expect(mocks.clearTokensIfMatch).not.toHaveBeenCalled();
  });

  it('recovers reuse grace by reloading newer stored tokens', async () => {
    mocks.loadTokens
      .mockResolvedValueOnce(TOKENS)
      .mockResolvedValueOnce(TOKENS)
      .mockResolvedValueOnce(NEXT_TOKENS);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(res(401, { error: 'expired' }))
        .mockResolvedValueOnce(res(409, { error: 'refresh_reuse_grace', reason: 'reuse_grace' }))
        .mockResolvedValueOnce(res(200, { value: 42 })),
    );

    await expect(api<{ value: number }>('/v1/thing')).resolves.toEqual({ value: 42 });
    expect(mocks.clearTokensIfMatch).not.toHaveBeenCalled();
  });

  it('does not clear tokens when reuse grace has no newer local token to use', async () => {
    mocks.loadTokens.mockResolvedValue(TOKENS);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(res(401, { error: 'expired' }))
        .mockResolvedValueOnce(res(409, { error: 'refresh_reuse_grace', reason: 'reuse_grace' })),
    );

    await expect(api('/v1/thing')).rejects.toBeInstanceOf(HttpError);
    expect(mocks.clearTokensIfMatch).not.toHaveBeenCalled();
  });

  it('does not clear a newer login if a stale refresh is terminally rejected', async () => {
    mocks.loadTokens
      .mockResolvedValueOnce(TOKENS)
      .mockResolvedValueOnce(TOKENS)
      .mockResolvedValueOnce(NEXT_TOKENS);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(401, { error: 'expired' }))
      .mockResolvedValueOnce(res(401, { error: 'invalid_refresh', reason: 'reuse' }))
      .mockResolvedValueOnce(res(200, { value: 42 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api<{ value: number }>('/v1/thing')).resolves.toEqual({ value: 42 });
    expect(mocks.clearTokensIfMatch).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[2]![1]?.headers).toMatchObject({ Authorization: 'Bearer a1' });
  });
});

function networkFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

describe('api() transport', () => {
  it('routes requests through the injected network fetch', async () => {
    const injected = vi.fn().mockResolvedValue(res(200, { ok: 1 }));
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    setNetworkFetchForTests(injected);

    await expect(api('/v1/open', { auth: false })).resolves.toEqual({ ok: 1 });
    expect(injected).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('bounds every request with the default timeout and an explicit override', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(200, {})));

    await api('/v1/a', { auth: false });
    await api('/v1/b', { auth: false, timeoutMs: 5_000 });

    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([DEFAULT_TIMEOUT_MS, 5_000]);
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
  });

  it('does not send the ngrok interstitial header to a real API host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await api('/v1/a', { auth: false });

    expect(fetchMock.mock.calls[0]![1]?.headers).not.toHaveProperty('ngrok-skip-browser-warning');
  });

  it('reports a TLS-inspecting proxy as a network error that says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkFailure('SELF_SIGNED_CERT_IN_CHAIN')));

    const err = await api('/v1/a', { auth: false }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiNetworkError);
    // Still a TypeError: the uploader classifies "unreachable" by it.
    expect(err).toBeInstanceOf(TypeError);
    expect(err).toMatchObject({ code: 'SELF_SIGNED_CERT_IN_CHAIN', tlsIntercepted: true });
  });

  it('does not flag an ordinary connection reset as interception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkFailure('ECONNRESET')));

    await expect(api('/v1/a', { auth: false })).rejects.toMatchObject({ code: 'ECONNRESET', tlsIntercepted: false });
  });

  it('builds the body from the session a retried request is actually sent with', async () => {
    mocks.loadTokens.mockResolvedValue(TOKENS);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(401, { error: 'expired' }))
      .mockResolvedValueOnce(res(200, { accessToken: 'a1', refreshToken: 'r1' }))
      .mockResolvedValueOnce(res(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/v1/auth/logout', { method: 'POST', bodyFromTokens: (t) => ({ refreshToken: t.refreshToken }) });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ refreshToken: 'r0' });
    // The rotation spent r0; revoking it again would leave r1 alive.
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual({ refreshToken: 'r1' });
  });
});

describe('refresh after no response', () => {
  it('retries the refresh once straight away, inside the server reuse grace', async () => {
    mocks.loadTokens.mockResolvedValue(TOKENS);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(401, { error: 'expired' }))
      .mockRejectedValueOnce(networkFailure('ETIMEDOUT'))
      .mockResolvedValueOnce(res(200, { accessToken: 'a1', refreshToken: 'r1' }))
      .mockResolvedValueOnce(res(200, { value: 42 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api<{ value: number }>('/v1/thing')).resolves.toEqual({ value: 42 });

    const refreshCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/auth/refresh'));
    expect(refreshCalls).toHaveLength(2);
    // Both attempts present the same token, so the server can replay its rotation.
    expect(refreshCalls.map(([, init]) => JSON.parse(init.body).refreshToken)).toEqual(['r0', 'r0']);
  });

  it('gives up after the one retry without signing out', async () => {
    mocks.loadTokens.mockResolvedValue(TOKENS);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(401, { error: 'expired' }))
      .mockRejectedValueOnce(networkFailure('ETIMEDOUT'))
      .mockRejectedValueOnce(networkFailure('ETIMEDOUT'));
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const off = onAuthChange((s) => seen.push(s));

    await expect(api('/v1/thing')).rejects.toBeInstanceOf(ApiNetworkError);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mocks.clearTokensIfMatch).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    off();
  });

  it('keeps concurrent 401s on one refresh, retry included', async () => {
    mocks.loadTokens.mockResolvedValue(TOKENS);
    let refreshAttempts = 0;
    const fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      if (url.endsWith('/v1/auth/refresh')) {
        refreshAttempts += 1;
        if (refreshAttempts === 1) throw networkFailure('ETIMEDOUT');
        return res(200, { accessToken: 'a1', refreshToken: 'r1' });
      }
      return init.headers.Authorization === 'Bearer a1' ? res(200, { value: 1 }) : res(401, { error: 'expired' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([api('/v1/a'), api('/v1/b'), api('/v1/c')]);

    expect(refreshAttempts).toBe(2);
  });

  it('marks a refresh-driven sign-out as the session ending, not a manual one', async () => {
    mocks.loadTokens.mockResolvedValue(TOKENS);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(res(401, { error: 'expired' }))
        .mockResolvedValueOnce(res(401, { error: 'invalid_refresh' })),
    );
    const seen: unknown[] = [];
    const off = onAuthChange((status, info) => seen.push([status, info]));

    await expect(api('/v1/thing')).rejects.toBeInstanceOf(UnauthorizedError);

    expect(seen).toEqual([['loggedOut', { reason: 'session_ended' }]]);
    off();
  });
});
