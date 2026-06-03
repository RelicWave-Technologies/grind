import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reportError, _resetSentryForTests } from './errorReporter';

const ORIGINAL_DSN = process.env.SENTRY_DSN;

beforeEach(() => {
  _resetSentryForTests();
  delete process.env.SENTRY_DSN;
});

afterEach(() => {
  _resetSentryForTests();
  if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIGINAL_DSN;
  vi.restoreAllMocks();
});

describe('reportError', () => {
  it('no-ops cleanly when SENTRY_DSN is unset', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    await reportError(new Error('boom'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops on an invalid DSN', async () => {
    process.env.SENTRY_DSN = 'not-a-url';
    _resetSentryForTests();
    const fetchSpy = vi.spyOn(global, 'fetch');
    await reportError(new Error('boom'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs an envelope when SENTRY_DSN is valid', async () => {
    process.env.SENTRY_DSN = 'https://abc123@sentry.example.com/42';
    _resetSentryForTests();
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));
    await reportError(new Error('boom'), { path: '/v1/foo', method: 'GET', userId: 'u1' });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://sentry.example.com/api/42/envelope/');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-sentry-envelope');
    expect(headers['X-Sentry-Auth']).toContain('sentry_key=abc123');
    const body = String((init as RequestInit).body);
    expect(body).toContain('/v1/foo'); // request URL field in event
    expect(body).toContain('boom');
    expect(body).toContain('"u1"');
  });

  it('swallows fetch failures (best-effort)', async () => {
    process.env.SENTRY_DSN = 'https://abc123@sentry.example.com/42';
    _resetSentryForTests();
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(reportError(new Error('boom'))).resolves.toBeUndefined();
  });

  it('serializes non-Error throwables', async () => {
    process.env.SENTRY_DSN = 'https://abc123@sentry.example.com/42';
    _resetSentryForTests();
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));
    await reportError('a string was thrown');
    const body = String((fetchSpy.mock.calls[0]![1] as RequestInit).body);
    expect(body).toContain('a string was thrown');
  });
});
