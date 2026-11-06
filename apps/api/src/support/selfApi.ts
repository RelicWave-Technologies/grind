import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Role } from '@grind/types';
import { signAccessToken } from '../lib/jwt';
import { logger } from '../logger';

/**
 * Read the dashboard's own answers for one person.
 *
 * The support agent must see the same hours, gaps and attendance codes the
 * person sees on Today, Edit time and Reports, so it asks the same endpoints
 * rather than re-deriving them. A private copy of the app listens on a random
 * loopback port; each call carries a short-lived token for the asker, so the
 * routes' own scoping applies and no call ever names another person.
 */

let server: Promise<{ server: Server; base: string }> | null = null;

async function start(): Promise<{ server: Server; base: string }> {
  // Imported late: the app's routes import the Lark intake, which imports this.
  const { buildApp } = await import('../app');
  const srv = createServer(buildApp({ requestLogs: false }));
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  srv.unref();
  const { port } = srv.address() as AddressInfo;
  return { server: srv, base: `http://127.0.0.1:${port}` };
}

export interface SelfApiCaller {
  userId: string;
  workspaceId: string;
  role: Role;
}

export class SelfApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`self_api_${status}:${code}`);
  }
}

/** GET a /v1 path as `who`. Throws SelfApiError on a non-2xx answer. */
export async function selfGet<T>(who: SelfApiCaller, path: string, timeoutMs = 20_000): Promise<T> {
  server ??= start().catch((err) => {
    server = null;
    throw err;
  });
  const { base } = await server;
  const token = signAccessToken({ sub: who.userId, ws: who.workspaceId, role: who.role });
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const code = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : 'error';
    logger.warn({ path, status: res.status, code }, 'support self-api call failed');
    throw new SelfApiError(res.status, code);
  }
  return body as T;
}

/** Close the loopback server (graceful shutdown, tests). */
export async function stopSelfApi(): Promise<void> {
  if (!server) return;
  const s = await server.catch(() => null);
  server = null;
  if (s) await new Promise<void>((resolve) => s.server.close(() => resolve()));
}
