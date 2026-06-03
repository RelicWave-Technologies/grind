import { logger } from '../logger';
import { API_VERSION } from './version';

/**
 * Minimal Sentry-compatible error reporter (M19). We deliberately avoid
 * adding the @sentry/node dependency for now — the SDK is heavy + brings
 * a startup-time hit. Instead we POST a single envelope to Sentry's
 * ingestion endpoint when SENTRY_DSN is set, and no-op when it isn't.
 *
 * The envelope payload mirrors the official format closely enough that
 * a DSN in a real Sentry project will receive + display these events.
 * Drop-in replace with `@sentry/node` later if richer features (breadcrumbs,
 * performance, source maps) are needed.
 *
 * Always best-effort — a failed report never blocks the request that
 * triggered it, and a malformed DSN logs a warning at boot once.
 */

interface ParsedDsn {
  url: string;
  publicKey: string;
}

let cachedDsn: ParsedDsn | null | undefined;

function parseDsn(): ParsedDsn | null {
  if (cachedDsn !== undefined) return cachedDsn;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    cachedDsn = null;
    return null;
  }
  try {
    // DSN format: https://<publicKey>@<host>/<projectId>
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\//, '');
    if (!publicKey || !projectId) throw new Error('missing key or project id');
    const envelopeUrl = `${u.protocol}//${u.host}/api/${projectId}/envelope/`;
    cachedDsn = { url: envelopeUrl, publicKey };
    logger.info({ projectId, host: u.host }, 'sentry: error reporter armed');
    return cachedDsn;
  } catch (err) {
    cachedDsn = null;
    logger.warn({ err: String(err) }, 'sentry: invalid SENTRY_DSN — error reporting disabled');
    return null;
  }
}

export interface ReportContext {
  /** Request path that triggered the error. */
  path?: string;
  /** HTTP method, when relevant. */
  method?: string;
  /** Authenticated user id, when known. Never log emails/names. */
  userId?: string;
  /** Free-form structured extras — keep it small. */
  extras?: Record<string, unknown>;
}

/**
 * Capture a server-side exception. Returns a promise that never rejects.
 * Caller can fire-and-forget with `void reportError(...)`.
 */
export async function reportError(err: unknown, ctx: ReportContext = {}): Promise<void> {
  const dsn = parseDsn();
  if (!dsn) return;
  try {
    const eventId = newEventId();
    const errOb = err instanceof Error ? err : new Error(String(err));
    const envelope = buildEnvelope(eventId, errOb, ctx);
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth':
        `Sentry sentry_version=7,` +
        `sentry_client=grind/${API_VERSION},` +
        `sentry_key=${dsn.publicKey}`,
    };
    // Best-effort: 2s timeout, swallow any failure.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    try {
      await fetch(dsn.url, {
        method: 'POST',
        headers,
        body: envelope,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch (postErr) {
    logger.debug({ err: String(postErr) }, 'sentry: report failed (non-fatal)');
  }
}

function buildEnvelope(eventId: string, err: Error, ctx: ReportContext): string {
  const now = new Date().toISOString();
  const header = JSON.stringify({ event_id: eventId, sent_at: now });
  const event = {
    event_id: eventId,
    timestamp: now,
    platform: 'node',
    level: 'error',
    release: API_VERSION,
    environment: process.env.NODE_ENV ?? 'development',
    server_name: process.env.HOSTNAME ?? undefined,
    transaction: ctx.path ? `${ctx.method ?? ''} ${ctx.path}`.trim() : undefined,
    user: ctx.userId ? { id: ctx.userId } : undefined,
    request: ctx.path ? { url: ctx.path, method: ctx.method } : undefined,
    extra: ctx.extras,
    exception: {
      values: [
        {
          type: err.name || 'Error',
          value: err.message,
          stacktrace: stack(err),
        },
      ],
    },
  };
  const itemHeader = JSON.stringify({ type: 'event' });
  const body = JSON.stringify(event);
  return `${header}\n${itemHeader}\n${body}\n`;
}

function stack(err: Error): { frames: Array<Record<string, unknown>> } | undefined {
  if (!err.stack) return undefined;
  const lines = err.stack.split('\n').slice(1).filter((l) => l.includes('at '));
  if (lines.length === 0) return undefined;
  return {
    frames: lines.reverse().map((line) => ({ function: line.trim() })),
  };
}

// 32-hex-char Sentry event id. Cheap pseudo-random — collisions are
// effectively impossible at our error volume.
function newEventId(): string {
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

/** Test-only — clear the parsed DSN cache so env mutations take effect. */
export function _resetSentryForTests(): void {
  cachedDsn = undefined;
}
