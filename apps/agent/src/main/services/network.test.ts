import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeNetworkError, isTlsInterceptionError, networkFetch, setNetworkFetchForTests } from './network';

afterEach(() => {
  setNetworkFetchForTests(null);
  vi.unstubAllGlobals();
});

function nodeFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

describe('describeNetworkError', () => {
  it.each([
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
  ])('flags the Node TLS failure %s as interception', (code) => {
    expect(describeNetworkError(nodeFailure(code))).toMatchObject({ code, tlsIntercepted: true });
  });

  it('flags a Chromium certificate failure from net.fetch', () => {
    const info = describeNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID'));
    expect(info).toMatchObject({ code: 'net::ERR_CERT_AUTHORITY_INVALID', tlsIntercepted: true });
  });

  it.each(['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED'])('does not flag %s', (code) => {
    expect(isTlsInterceptionError(nodeFailure(code))).toBe(false);
  });

  it('recognises our own timeout', () => {
    const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(describeNetworkError(err)).toMatchObject({ timedOut: true, tlsIntercepted: false });
  });
});

describe('networkFetch', () => {
  it('falls back to the global fetch outside an Electron main process', async () => {
    const globalFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', globalFetch);

    await networkFetch('https://example.test/a');

    expect(globalFetch).toHaveBeenCalledWith('https://example.test/a', undefined);
  });

  it('uses the injected fetch when a test provides one', async () => {
    const injected = vi.fn().mockResolvedValue(new Response('ok'));
    setNetworkFetchForTests(injected);

    await networkFetch('https://example.test/b', { method: 'POST' });

    expect(injected).toHaveBeenCalledWith('https://example.test/b', { method: 'POST' });
  });
});
