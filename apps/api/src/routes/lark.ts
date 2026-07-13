import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { logger } from '../logger';
import {
  isLarkConfigured,
  getLarkConfig,
  getTokenManager,
  getTenantClient,
  getUserTaskClient,
  resolveIdentity,
  signOAuthState,
  verifyOAuthState,
  buildAuthorizeUrl,
  loggedMsByGuid,
  LARK_SCOPES,
  LarkReauthRequiredError,
  LarkTransientError,
  LarkTaskApiError,
} from '../lark';
import { localDayWindow } from '../insights/day';
import { latestSampleByEntry, latestScreenshotByEntry } from '../insights/openSegmentEvidence';

export const larkRouter = Router();

function taskErrorDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]').slice(0, 2000);
}

/** Minimal HTML shown in the browser tab after the OAuth round-trip. */
function closeTabPage(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#faf9fd;color:#1c1c1e}
.card{max-width:380px;text-align:center;padding:32px;border-radius:16px;background:#fff;box-shadow:0 8px 30px rgba(90,60,200,.12)}
h1{font-size:18px;margin:0 0 8px}p{color:#6b6b76;margin:0}</style>
<div class="card"><h1>${title}</h1><p>${detail}</p></div>`;
}

/**
 * OAuth callback — hit by the BROWSER (no Grind JWT). Mounted before the
 * auth middleware. The signed `state` token identifies the initiating user and
 * provides CSRF protection.
 */
larkRouter.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  try {
    if (!isLarkConfigured()) return res.status(503).send(closeTabPage('Lark unavailable', 'Integration is not configured.'));
    if (error) return res.status(400).send(closeTabPage('Authorization cancelled', String(error)));
    if (!code || !state) return res.status(400).send(closeTabPage('Invalid request', 'Missing code or state.'));

    let userId: string;
    try {
      ({ sub: userId } = verifyOAuthState(state));
    } catch {
      return res.status(400).send(closeTabPage('Link expired', 'Please start the Lark connection again.'));
    }

    const { redirectUri } = getLarkConfig();
    if (!redirectUri) throw new Error('LARK_OAUTH_REDIRECT_URI not set');

    const tm = getTokenManager()!;
    await tm.connect(userId, code, redirectUri);

    // Best-effort identity resolution; the OAuth connection still succeeds if
    // the tenant lookup fails (e.g. missing contact scope on the app).
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const tenant = getTenantClient();
      if (user && tenant) await resolveIdentity(prisma, userId, user.email, tenant);
    } catch (err) {
      logger.warn({ err: String(err), userId }, 'lark identity resolution failed (non-fatal)');
    }

    res.status(200).send(closeTabPage('Lark connected', 'You can close this tab and return to Grind.'));
  } catch (err) {
    logger.error({ err: String(err) }, 'lark oauth callback failed');
    res.status(500).send(closeTabPage('Connection failed', 'Something went wrong. Please try again.'));
  }
});

// Everything below requires a Grind access token.
larkRouter.use(requireAccessToken);

/**
 * Begin the OAuth flow: returns the authorize URL for the agent to open in the
 * system browser. The signed state carries the user id back to the callback.
 */
larkRouter.get('/oauth/start', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (!isLarkConfigured()) return res.status(503).json({ error: 'lark_not_configured' });
  const { accountsHost, appId, redirectUri } = getLarkConfig();
  if (!redirectUri) return res.status(500).json({ error: 'redirect_uri_not_set' });
  const state = signOAuthState(req.user.sub);
  const authorizeUrl = buildAuthorizeUrl({ accountsHost, appId, redirectUri, state });
  res.json({ authorizeUrl });
});

/** Connection status for the signed-in user. Always 200. */
larkRouter.get('/status', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!isLarkConfigured()) {
      return res.json({ configured: false, connected: false, reauthRequired: false, scopes: [] });
    }
    const status = await getTokenManager()!.getStatus(req.user.sub);
    res.json({
      configured: true,
      connected: status.connected,
      reauthRequired: status.reauthRequired,
      scopes: status.scopes,
      missingScopes: status.missingScopes,
      requestedScopes: LARK_SCOPES,
      refreshExpiresAt: status.refreshExpiresAt,
      lastRefreshedAt: status.lastRefreshedAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * List the signed-in user's Lark tasks for the agent's task picker. Uses the
 * per-user token (rotating it if needed). Returns 409 `reauth_required` when
 * the user must reconnect Lark, 503 when the integration is off.
 */
larkRouter.get('/my-tasks', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!isLarkConfigured()) return res.status(503).json({ error: 'lark_not_configured' });
    const tm = getTokenManager()!;
    const client = getUserTaskClient()!;
    let accessToken: string;
    try {
      accessToken = await tm.getAccessToken(req.user.sub);
    } catch (err) {
      if (err instanceof LarkReauthRequiredError) {
        return res.status(409).json({ error: 'reauth_required' });
      }
      throw err;
    }
    const tasks = await client.listMyTasks(accessToken);
    const nowMs = Date.now();
    const rawDate = typeof req.query.date === 'string' && req.query.date.length > 0 ? req.query.date : null;
    const rawTz = typeof req.query.tz === 'string' && req.query.tz.length > 0 ? req.query.tz : null;
    const dayWindow = rawDate || rawTz ? localDayWindow(rawDate ?? new Date(nowMs).toISOString().slice(0, 10), rawTz ?? 'UTC') : null;
    if ((rawDate || rawTz) && !dayWindow) return res.status(400).json({ error: 'invalid_date_or_tz' });

    // Enrich with time already tracked against each task via Grind.
    const guids = tasks.map((t) => t.guid);
    if (guids.length) {
      const [entries, runtime] = await Promise.all([
        prisma.timeEntry.findMany({
          where: { userId: req.user.sub, larkTaskGuid: { in: guids } },
          select: {
            id: true,
            larkTaskGuid: true,
            trackingProtocolVersion: true,
            lastProvenAt: true,
            leaseExpiresAt: true,
            screenshots: {
              where: { deletedAt: null },
              orderBy: { capturedAt: 'desc' },
              take: 1,
              select: { capturedAt: true },
            },
            segments: { select: { kind: true, startedAt: true, endedAt: true } },
          },
        }),
        prisma.user.findUnique({
          where: { id: req.user.sub },
          select: { agentState: true, agentActiveEntryId: true, agentLastSeenAt: true },
        }),
      ]);
      const openEntryIds = entries
        .filter((e) => e.segments.some((s) => s.endedAt === null))
        .map((e) => e.id);
      const samples = openEntryIds.length
        ? await prisma.activitySample.findMany({
            where: { userId: req.user.sub, timeEntryId: { in: openEntryIds } },
            select: { timeEntryId: true, bucketStart: true },
            orderBy: { bucketStart: 'asc' },
          })
        : [];
      const latestSampleAt = latestSampleByEntry(samples);
      const latestScreenshotAt = latestScreenshotByEntry(entries.flatMap((entry) =>
        entry.screenshots.map((screenshot) => ({ timeEntryId: entry.id, capturedAt: screenshot.capturedAt })),
      ));
      const latestHeartbeatAt = new Map<string, Date>();
      if (runtime?.agentState === 'RUNNING' && runtime.agentActiveEntryId && runtime.agentLastSeenAt) {
        latestHeartbeatAt.set(runtime.agentActiveEntryId, runtime.agentLastSeenAt);
      }
      const loggedTotal = loggedMsByGuid(entries, nowMs, { latestSampleAt, latestScreenshotAt, latestHeartbeatAt });
      const loggedToday = dayWindow
        ? loggedMsByGuid(entries, nowMs, {
            latestSampleAt,
            latestScreenshotAt,
            latestHeartbeatAt,
            windowStart: dayWindow.start.getTime(),
            windowEnd: dayWindow.end.getTime(),
          })
        : loggedTotal;
      for (const t of tasks) {
        t.loggedTodayMs = loggedToday.get(t.guid) ?? 0;
        t.loggedTotalMs = loggedTotal.get(t.guid) ?? 0;
        t.loggedMs = dayWindow ? t.loggedTodayMs : t.loggedTotalMs;
      }
    }
    // Resolve creator display names (best-effort; needs a tenant token + contact scope).
    const tenant = getTenantClient();
    const creatorIds = tasks.map((t) => t.creatorId).filter((id): id is string => !!id);
    if (tenant && creatorIds.length) {
      try {
        const names = await tenant.namesByOpenId(creatorIds);
        for (const t of tasks) if (t.creatorId) t.creatorName = names.get(t.creatorId) ?? null;
      } catch (err) {
        logger.warn({ err: String(err) }, 'lark creator name resolution failed (non-fatal)');
      }
    }
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

/**
 * Create a Lark task on behalf of the user. Body: { summary, due?, description? }.
 * Returns the created task DTO. 409 reauth / 503 unconfigured as elsewhere.
 */
larkRouter.post('/tasks', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!isLarkConfigured()) return res.status(503).json({ error: 'lark_not_configured' });
    const { summary, due, description } = (req.body ?? {}) as {
      summary?: unknown;
      due?: unknown;
      description?: unknown;
    };
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      return res.status(400).json({ error: 'summary_required' });
    }
    const dueMs = typeof due === 'number' && Number.isFinite(due) ? due : null;
    const tm = getTokenManager()!;
    const client = getUserTaskClient()!;
    let accessToken: string;
    try {
      accessToken = await tm.getAccessToken(req.user.sub);
    } catch (err) {
      if (err instanceof LarkReauthRequiredError) return res.status(409).json({ error: 'reauth_required' });
      if (err instanceof LarkTransientError) {
        const detail = taskErrorDetail(err);
        logger.warn({ err: detail, userId: req.user.sub }, 'lark token refresh transient during task create');
        return res.status(503).json({ error: 'lark_temporarily_unavailable', detail });
      }
      throw err;
    }
    // Resolve the token owner's open_id so the new task is assigned to them
    // (otherwise it won't appear in their my_tasks list).
    const assigneeOpenId = await client.getOpenId(accessToken).catch(() => null);
    let task: Awaited<ReturnType<typeof client.createTask>>;
    try {
      task = await client.createTask(accessToken, {
        summary: summary.trim().slice(0, 256),
        due: dueMs,
        description: typeof description === 'string' ? description.slice(0, 2000) : null,
        assigneeOpenId,
      });
    } catch (err) {
      if (err instanceof LarkTaskApiError) {
        logger.warn({ err: err.message, code: err.code, userId: req.user.sub }, 'lark task create failed');
        return res.status(502).json({ error: 'lark_create_failed', detail: err.message });
      }
      const detail = taskErrorDetail(err);
      logger.warn({ err: detail, userId: req.user.sub }, 'lark task create failed unexpectedly');
      return res.status(502).json({ error: 'lark_create_failed', detail });
    }
    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
});

/** Disconnect: forget the user's Lark tokens. */
larkRouter.post('/disconnect', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const tm = getTokenManager();
    if (tm) await tm.disconnect(req.user.sub);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default larkRouter;
