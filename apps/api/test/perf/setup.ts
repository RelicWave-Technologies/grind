import net from 'node:net';
import { PrismaClient } from '@prisma/client';

/**
 * Setup for the opt-in endpoint benchmark (vitest.perf.config.ts).
 *
 * Unlike test/setup.ts this does NOT truncate between tests: the seeded volume
 * is the point, and it is reused across runs. It also:
 *
 *  - routes Prisma through an in-process TCP proxy that delays every chunk by
 *    PERF_RTT_MS/2 each way, so a query costs a network round trip the way it
 *    does against the remote production Postgres (local Postgres answers in
 *    ~0.1 ms, which hides N+1 and sequential-await costs completely);
 *  - installs the Prisma singleton with query events, so the benchmark can
 *    count the SQL statements each request issues.
 */

const baseUrl = process.env.PERF_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error('PERF_DATABASE_URL / TEST_DATABASE_URL not set');
process.env.NODE_ENV = 'test';
process.env.ALLOW_PASSWORD_LOGIN = 'true';
delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;
delete process.env.LARK_TOKEN_KEY;
delete process.env.LARK_LOGIN_REDIRECT_URI;
delete process.env.LARK_CONNECT_REDIRECT_URI;
delete process.env.LARK_OAUTH_REDIRECT_URI;
process.env.TIMO_TESTER_BOT_ENABLED = 'false';

const rttMs = Number(process.env.PERF_RTT_MS ?? '0');

async function startLatencyProxy(target: URL, oneWayMs: number): Promise<number> {
  const targetPort = Number(target.port || 5432);
  const targetHost = target.hostname;
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    const pipe = (from: net.Socket, to: net.Socket) => {
      from.on('data', (chunk) => {
        setTimeout(() => {
          if (!to.destroyed) to.write(chunk);
        }, oneWayMs);
      });
      from.on('close', () => setTimeout(() => to.destroy(), oneWayMs));
      from.on('error', () => to.destroy());
    };
    pipe(client, upstream);
    pipe(upstream, client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  return (server.address() as net.AddressInfo).port;
}

let url = baseUrl;
if (rttMs > 0) {
  const parsed = new URL(url);
  const port = await startLatencyProxy(parsed, rttMs / 2);
  parsed.hostname = '127.0.0.1';
  parsed.port = String(port);
  url = parsed.toString();
}
// PERF_CONN_LIMIT=N caps Prisma's pool (production's pooled URL may set
// connection_limit, which turns every Promise.all back into a queue).
if (process.env.PERF_CONN_LIMIT) {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', process.env.PERF_CONN_LIMIT);
  url = parsed.toString();
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;

export interface QueryLog {
  count: number;
  totalDbMs: number;
  queries: string[];
}

const perfLog: QueryLog = { count: 0, totalDbMs: 0, queries: [] };

const client = new PrismaClient({
  datasources: { db: { url } },
  log: [{ emit: 'event', level: 'query' }],
});
client.$on('query', (e) => {
  perfLog.count += 1;
  perfLog.totalDbMs += e.duration;
  if (process.env.PERF_TRACE) perfLog.queries.push(e.query.slice(0, 160));
});
(globalThis as unknown as { __grindPrisma: PrismaClient }).__grindPrisma = client;
(globalThis as unknown as { __perfLog: QueryLog }).__perfLog = perfLog;

await import('@grind/db');
