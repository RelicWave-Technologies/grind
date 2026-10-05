import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { outboundTimeoutSignal, OUTBOUND_TIMEOUT_MS } from './outboundTimeout';

// A peer that accepts the request and never answers — the case that used to
// park a scheduler tick or request handler forever.
const server = http.createServer(() => {});
const ready = new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('outboundTimeoutSignal', () => {
  it('defaults to a finite bound', () => {
    expect(OUTBOUND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(OUTBOUND_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('aborts a fetch to a peer that never answers', async () => {
    const port = await ready;
    const started = Date.now();
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: outboundTimeoutSignal(100) })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
