import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
  clearTokens: vi.fn(),
}));

vi.mock('./tokenStore', () => ({
  loadTokens: mocks.loadTokens,
  saveTokens: mocks.saveTokens,
  clearTokens: mocks.clearTokens,
}));
vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { api, UnauthorizedError, HttpError, onAuthChange } = await import('./apiClient');

const TOKENS = { accessToken: 'a0', refreshToken: 'r0', userId: 'u', workspaceId: 'w' };

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
  mocks.loadTokens.mockReset();
  mocks.saveTokens.mockReset();
  mocks.clearTokens.mockReset();
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
    expect(mocks.clearTokens).not.toHaveBeenCalled();
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
    expect(mocks.clearTokens).toHaveBeenCalledOnce();
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
    expect(mocks.saveTokens).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'a1', refreshToken: 'r1' }),
    );
  });
});
