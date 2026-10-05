import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { shutdownGracefully, onShutdown, isShuttingDown, _resetLifecycleForTests } from '../src/lib/lifecycle';
import { inStartupGrace, TIMER_LEASE_MS } from '../src/timeLifecycle';

afterEach(() => {
  _resetLifecycleForTests();
});

function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  return new Promise<{ server: http.Server; port: number }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })),
  );
}

describe('graceful shutdown', () => {
  it('stops schedulers, lets an in-flight request finish, then disconnects and exits 0', async () => {
    const order: string[] = [];
    const { server, port } = await listen((_req, res) => {
      setTimeout(() => {
        order.push('request-finished');
        res.end('done');
      }, 150);
    });
    onShutdown(() => { order.push('scheduler-stopped'); });

    const inFlight = fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 30)); // request is now in flight

    let exitCode: number | null = null;
    await shutdownGracefully('SIGTERM', {
      server,
      disconnect: async () => { order.push('db-disconnected'); },
      exit: (code) => { exitCode = code; order.push('exit'); },
      timeoutMs: 5_000,
    });

    expect(await inFlight).toBe('done');
    expect(isShuttingDown()).toBe(true);
    expect(exitCode).toBe(0);
    expect(order).toEqual(['scheduler-stopped', 'request-finished', 'db-disconnected', 'exit']);
  });

  it('cuts a request that outlives the timeout instead of hanging the deploy', async () => {
    const { server, port } = await listen(() => { /* never answers */ });
    const hung = fetch(`http://127.0.0.1:${port}/`).catch(() => 'cut');
    await new Promise((r) => setTimeout(r, 30));
    let exited = false;
    const started = Date.now();
    await shutdownGracefully('SIGTERM', {
      server,
      disconnect: async () => {},
      exit: () => { exited = true; },
      timeoutMs: 200,
    });
    expect(exited).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await hung).toBe('cut');
  });

  it('runs once even if the signal arrives twice', async () => {
    const { server } = await listen((_req, res) => res.end());
    let exits = 0;
    const deps = { server, disconnect: async () => {}, exit: () => { exits += 1; }, timeoutMs: 1_000 };
    await Promise.all([shutdownGracefully('SIGTERM', deps), shutdownGracefully('SIGINT', deps)]);
    expect(exits).toBe(1);
  });
});

describe('timer lease reconciler after a restart', () => {
  it('holds off for one lease length after the process starts', () => {
    const start = Date.parse('2026-10-05T10:00:00.000Z');
    expect(inStartupGrace(start, start)).toBe(true);
    expect(inStartupGrace(start + TIMER_LEASE_MS - 1, start)).toBe(true);
    expect(inStartupGrace(start + TIMER_LEASE_MS, start)).toBe(false);
  });
});
