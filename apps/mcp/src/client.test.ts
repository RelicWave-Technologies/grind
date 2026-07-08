import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimoApiError, TimoClient } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TimoClient', () => {
  it('calls the configured API with the bearer token', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new TimoClient({
      apiBase: 'https://timo.example.com',
      apiToken: 'secret-token',
    });

    await expect(client.get('/v1/mcp/people', { q: 'Anish', limit: 10 })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://timo.example.com/v1/mcp/people?q=Anish&limit=10');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer secret-token',
    });
  });

  it('turns API failures into tool-friendly errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'insufficient_scope' }), { status: 403 }),
    ));

    const client = new TimoClient({
      apiBase: 'https://timo.example.com',
      apiToken: 'secret-token',
    });

    await expect(client.get('/v1/mcp/device-health')).rejects.toBeInstanceOf(TimoApiError);
    await expect(client.get('/v1/mcp/device-health')).rejects.toThrow('insufficient_scope');
  });
});
