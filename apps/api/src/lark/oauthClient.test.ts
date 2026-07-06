import { afterEach, describe, expect, it, vi } from 'vitest';

// Isolate the HTTP client from real Lark config + network.
vi.mock('./config', () => ({
  getLarkConfig: () => ({ appId: 'id', appSecret: 'secret', oauthHost: 'https://oauth.test' }),
  LARK_SCOPE_STRING: 'task:task:read',
}));

const { HttpOAuthClient, LarkTransientError, LarkReauthRequiredError } = await import('./oauthClient');

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const client = new HttpOAuthClient();
const success = {
  code: 0,
  access_token: 'at',
  expires_in: 7200,
  refresh_token: 'rt',
  refresh_token_expires_in: 604800,
  scope: 'task:task:read',
};

afterEach(() => vi.unstubAllGlobals());

describe('HttpOAuthClient: transient vs reauth classification', () => {
  it('network error → transient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    await expect(client.refresh('r')).rejects.toBeInstanceOf(LarkTransientError);
  });

  it('5xx → transient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(503, {})));
    await expect(client.refresh('r')).rejects.toBeInstanceOf(LarkTransientError);
  });

  it('non-5xx infra failure with no explicit error (e.g. proxy/WAF 403) → transient, NOT reauth', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(403, {})));
    await expect(client.refresh('r')).rejects.toBeInstanceOf(LarkTransientError);
  });

  it('truncated 200 body (no tokens, no error) → transient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(200, {})));
    await expect(client.refresh('r')).rejects.toBeInstanceOf(LarkTransientError);
  });

  it('explicit OAuth error → reauth-required', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(400, { error: 'invalid_grant' })));
    await expect(client.refresh('r')).rejects.toBeInstanceOf(LarkReauthRequiredError);
  });

  it('explicit non-zero Lark code → reauth-required', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(200, { code: 20037, error_description: 'bad token' })));
    await expect(client.refresh('r')).rejects.toBeInstanceOf(LarkReauthRequiredError);
  });

  it('success → token pair', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(200, success)));
    await expect(client.refresh('r')).resolves.toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
  });
});
