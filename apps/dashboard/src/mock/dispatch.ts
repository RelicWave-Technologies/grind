/**
 * Turns a (method, URL, body) into a mocked response: route match, dev-panel
 * switches (signed out, errors, latency), the handler, and a schema check.
 * `handle` is synchronous and DOM-free so the self-test can drive it directly.
 */
import { todayKey } from './clock';
import { getDb, registerSeeder } from './db';
import { registerAll } from './handlers';
import { resolveMe } from './handlers/session';
import { HttpError, isRaw, match, type Ctx } from './http';
import { seedDb } from './seed';
import { getSettings, type MockSettings } from './settings';
import { checkResponse } from './validate';

registerSeeder(seedDb);
registerAll();

export interface MockResult {
  status: number;
  contentType: string;
  body: BodyInit | null;
  /** Parsed body when it is JSON. */
  json?: unknown;
  filename?: string;
  /** Matched route pattern, or null when nothing matched. */
  pattern: string | null;
  /** Schema-check failure, when the route has a schema. */
  issue?: string | null;
}

function jsonResult(status: number, body: unknown, pattern: string | null, issue: string | null = null): MockResult {
  return { status, contentType: 'application/json', body: JSON.stringify(body), json: body, pattern, issue };
}

const warned = new Set<string>();

/** What this page load has seen go wrong — `__timoMock.issues()` in the console. */
export const issues = { unmocked: [] as string[], crashed: [] as string[], schema: [] as string[] };

function warnOnce(key: string, ...args: unknown[]): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(...args);
}

export function handle(method: string, url: URL, body: unknown, settings: MockSettings = getSettings()): MockResult {
  const path = url.pathname;
  const m = match(method, path);
  if (!m) {
    if (!issues.unmocked.includes(`${method} ${path}`)) issues.unmocked.push(`${method} ${path}`);
    warnOnce(`unmocked ${method} ${path}`, `[timo mock] UNMOCKED ${method} ${path}${url.search} — add a handler in src/mock/handlers`);
    return jsonResult(404, { error: 'not_mocked', method, path }, null);
  }
  if (settings.errors && !path.startsWith('/v1/auth/')) {
    return jsonResult(500, { error: 'mock_server_error' }, m.route.pattern);
  }
  if (settings.signedOut && !m.route.public) return jsonResult(401, { error: 'unauthorized' }, m.route.pattern);

  const db = getDb(todayKey());
  const ctx: Ctx = { db, me: resolveMe(db, settings.role), now: Date.now(), empty: settings.empty };
  try {
    const out = m.handler({ method, path, params: m.params, query: url.searchParams, body }, ctx);
    if (isRaw(out)) {
      const parsed: unknown = out.contentType === 'application/json' && typeof out.body === 'string' ? JSON.parse(out.body) : undefined;
      return {
        status: out.status,
        contentType: out.contentType,
        body: out.body,
        json: parsed,
        filename: out.filename,
        pattern: m.route.pattern,
        issue: parsed === undefined ? null : checkResponse(method, m.route.pattern, parsed),
      };
    }
    return jsonResult(200, out, m.route.pattern, checkResponse(method, m.route.pattern, out));
  } catch (e) {
    if (e instanceof HttpError) return jsonResult(e.status, e.body, m.route.pattern);
    issues.crashed.push(`${method} ${path}: ${e instanceof Error ? e.message : String(e)}`);
    console.error('[timo mock] handler crashed', method, path, e);
    return jsonResult(500, { error: 'mock_handler_crashed', message: e instanceof Error ? e.message : String(e) }, m.route.pattern);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function respond(method: string, url: URL, body: unknown): Promise<Response> {
  const settings = getSettings();
  // The session check stays instant so the shell renders and screens show
  // their own skeletons instead of a blank page.
  if (settings.latencyMs > 0 && !url.pathname.startsWith('/v1/auth/')) await sleep(settings.latencyMs);
  const r = handle(method, url, body, getSettings());
  if (r.issue && !issues.schema.some((x) => x.startsWith(`${method} ${r.pattern}`))) issues.schema.push(`${method} ${r.pattern}: ${r.issue}`);
  if (r.issue) warnOnce(`schema ${method} ${r.pattern}`, `[timo mock] ${method} ${r.pattern} does not match its @grind/types schema: ${r.issue}`);
  const headers = new Headers({ 'Content-Type': r.contentType, 'X-Timo-Mock': '1' });
  if (r.filename) headers.set('Content-Disposition', `attachment; filename="${r.filename}"`);
  return new Response(r.body, { status: r.status, headers });
}
