import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { shutdownGracefully, onShutdown, isShuttingDown, _resetLifecycleForTests } from '../src/lib/lifecycle';
import { reconcileGate, TIMER_LEASE_MS } from '../src/timeLifecycle';

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

describe('timer lease reconciler after a restart or an outage', () => {
  const start = Date.parse('2026-10-05T10:00:00.000Z');

  it('holds off for one lease length after the process starts', () => {
    const fresh = { resumedAtMs: start, lastOkAtMs: null };
    expect(reconcileGate(start, fresh).finalize).toBe(false);
    expect(reconcileGate(start + TIMER_LEASE_MS - 1, fresh).finalize).toBe(false);
    expect(reconcileGate(start + TIMER_LEASE_MS, fresh).finalize).toBe(true);
  });

  it('holds off again for a lease after it could not reach the database for longer than one', () => {
    const lastOk = start + 10 * TIMER_LEASE_MS;
    const clock = { resumedAtMs: start, lastOkAtMs: lastOk };
    // Ticking normally: finalize.
    expect(reconcileGate(lastOk + 60_000, clock)).toEqual({ finalize: true, resumedAtMs: start });
    // Back after a blind stretch: the wait restarts now.
    const back = lastOk + TIMER_LEASE_MS + 1;
    const gate = reconcileGate(back, clock);
    expect(gate).toEqual({ finalize: false, resumedAtMs: back });
    const resumed = { resumedAtMs: gate.resumedAtMs, lastOkAtMs: back };
    expect(reconcileGate(back + 60_000, resumed).finalize).toBe(false);
    expect(reconcileGate(back + TIMER_LEASE_MS, { ...resumed, lastOkAtMs: back + 120_000 }).finalize).toBe(true);
  });
});
