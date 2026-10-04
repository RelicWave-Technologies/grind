/**
 * A tiny method + path-pattern router for the mocked API. Handlers receive a
 * parsed request and a context (store, signed-in user, clock, dev-panel
 * switches) and return a plain value, which is sent as JSON with status 200.
 * Throw `HttpError` for anything else, or return `raw(...)` for files.
 */
import type { MockDb, DbUser } from './db';

export interface Ctx {
  db: MockDb;
  me: DbUser;
  now: number;
  /** "Empty workspace" switch: lists come back empty. */
  empty: boolean;
}

export interface MockRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? status));
  }
}

export function fail(status: number, error: string, extra: Record<string, unknown> = {}): never {
  throw new HttpError(status, { error, ...extra });
}

export interface RawResponse {
  __raw: true;
  status: number;
  body: BodyInit;
  contentType: string;
  filename?: string;
}

export function raw(body: BodyInit, contentType: string, filename?: string, status = 200): RawResponse {
  return { __raw: true, status, body, contentType, filename };
}

export function withStatus(status: number, body: unknown): RawResponse {
  return raw(JSON.stringify(body), 'application/json', undefined, status);
}

export function isRaw(v: unknown): v is RawResponse {
  return typeof v === 'object' && v !== null && (v as { __raw?: unknown }).__raw === true;
}

export type Handler = (req: MockRequest, ctx: Ctx) => unknown;

interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  /** Reachable without a session (auth flow). */
  public: boolean;
}

const routes: Route[] = [];

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

export function route(method: string, pattern: string, handler: Handler, opts: { public?: boolean } = {}): void {
  const { regex, keys } = compile(pattern);
  routes.push({ method: method.toUpperCase(), pattern, regex, keys, handler, public: opts.public ?? false });
}

export const get = (p: string, h: Handler, o?: { public?: boolean }) => route('GET', p, h, o);
export const post = (p: string, h: Handler, o?: { public?: boolean }) => route('POST', p, h, o);
export const patch = (p: string, h: Handler) => route('PATCH', p, h);
export const put = (p: string, h: Handler) => route('PUT', p, h);
export const del = (p: string, h: Handler) => route('DELETE', p, h);

export interface Match {
  route: { method: string; pattern: string; public: boolean };
  params: Record<string, string>;
  handler: Handler;
}

export function match(method: string, path: string): Match | null {
  for (const r of routes) {
    if (r.method !== method.toUpperCase()) continue;
    const m = r.regex.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1] ?? '');
    });
    return { route: { method: r.method, pattern: r.pattern, public: r.public }, params, handler: r.handler };
  }
  return null;
}

export function listRoutes(): Array<{ method: string; pattern: string }> {
  return routes.map((r) => ({ method: r.method, pattern: r.pattern }));
}

// ---------------------------------------------------------------------------
// Small body helpers
// ---------------------------------------------------------------------------

export function bodyObject(req: MockRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
