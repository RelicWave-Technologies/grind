import { Router, type Response } from 'express';
import crypto from 'node:crypto';
import { prisma } from '@grind/db';
import {
  AgentLarkExchangeRequest,
  type AgentLarkExchangeResponse,
  type LarkLoginOutcome,
} from '@grind/types';
import {
  isLarkConfigured,
  getLarkConfig,
  getTokenManager,
  getProfileClient,
  buildAuthorizeUrl,
  signLoginState,
  verifyLoginState,
  verifyExpiredAgentLoginRouteHint,
  LARK_SCOPE_STRING,
  LarkTransientError,
} from '../lark';
import {
  resolveUser,
  createAgentAuthCode,
  redeemAgentAuthCode,
  AgentCodeError,
} from '../auth/larkLogin';
import { signAccessToken } from '../lib/jwt';
import { issueRefreshToken } from '../lib/refreshToken';
import { setSessionCookie, setRefreshCookie } from '../lib/cookies';
import { validate } from '../middleware/validate';
import { env } from '../env';
import { logger } from '../logger';

/**
 * Lark OAuth LOGIN routes (distinct from the /v1/lark connect flow). Mounted
 * before requireAccessToken — /start and /callback are browser-facing and
 * unauthenticated; the session is issued by the callback. See
 * docs/auth-lark-plan.md §3.
 */
export const authLarkRouter = Router();

const STATE_COOKIE = 'grind_login_state';
const STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

function crossSite(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Canonical dashboard origin for post-login redirects (never a user param). */
function dashboardBase(): string {
  const first = (process.env.DASHBOARD_URL || env.DASHBOARD_URL || '').split(',')[0]?.trim().replace(/\/$/u, '');
  return first || 'http://localhost:5174';
}

type Terminal = { error?: LarkLoginOutcome; status?: 'pending' };
type AgentCallbackScheme = 'grind' | 'timo';

function parseAgentCallbackScheme(value: unknown): AgentCallbackScheme {
  return value === 'timo' ? 'timo' : 'grind';
}

/** Deliver a terminal outcome to the right client surface. */
function finish(
  res: Response,
  client: 'dashboard' | 'agent',
  t: Terminal,
  agentCallbackScheme: AgentCallbackScheme = 'grind',
): void {
  const qs = t.error ? `error=${t.error}` : `status=${t.status ?? 'pending'}`;
  if (client === 'agent') {
    res.redirect(`${agentCallbackScheme}://auth?${qs}`);
    return;
  }
  res.redirect(`${dashboardBase()}/login?${qs}`);
}

function setStateCookie(res: Response, nonce: string): void {
  res.cookie(STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: crossSite() ? 'none' : 'lax',
    secure: crossSite(),
    maxAge: STATE_COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

function clearStateCookie(res: Response): void {
  res.clearCookie(STATE_COOKIE, {
    path: '/',
    sameSite: crossSite() ? 'none' : 'lax',
    secure: crossSite(),
  });
}

/**
 * GET /v1/auth/lark/start — kick off the OAuth flow. `client=dashboard|agent`;
 * the agent supplies `code_challenge` (its PKCE S256), bound into the state.
 */
authLarkRouter.get('/start', (req, res) => {
  const client = req.query.client === 'agent' ? 'agent' : 'dashboard';
  const agentCallbackScheme = client === 'agent' ? parseAgentCallbackScheme(req.query.callback_scheme) : 'grind';
  if (!isLarkConfigured()) return finish(res, client, { error: 'config' }, agentCallbackScheme);
  const cfg = getLarkConfig();
  if (!cfg.redirectUri) return finish(res, client, { error: 'config' }, agentCallbackScheme);

  let agentChallenge: string | undefined;
  if (client === 'agent') {
    agentChallenge = typeof req.query.code_challenge === 'string' ? req.query.code_challenge : '';
    if (!agentChallenge) return finish(res, client, { error: 'invalid_request' }, agentCallbackScheme);
  }

  const nonce = crypto.randomBytes(16).toString('base64url');
  const state =
    client === 'agent'
      ? signLoginState({ nonce, client, agentChallenge, agentCallbackScheme })
      : signLoginState({ nonce, client });
  if (client === 'dashboard') setStateCookie(res, nonce);

  const url = buildAuthorizeUrl({
    accountsHost: cfg.accountsHost,
    appId: cfg.appId,
    redirectUri: cfg.redirectUri,
    state,
    scope: LARK_SCOPE_STRING, // already includes contact:user.email:readonly
  });
  res.redirect(url);
});

/**
 * GET /v1/auth/lark/callback — Lark redirects here. Resolve identity, provision,
 * and either issue a session (ACTIVE) or route the user to pending/error.
 */
authLarkRouter.get('/callback', async (req, res, next) => {
  // Parse state first so even errors route to the right client surface.
  let payload: {
    nonce: string;
    client: 'dashboard' | 'agent';
    agentChallenge?: string;
    agentCallbackScheme?: AgentCallbackScheme;
  };
  try {
    payload = verifyLoginState(String(req.query.state ?? ''));
  } catch {
    const hint = verifyExpiredAgentLoginRouteHint(String(req.query.state ?? ''));
    if (hint) return finish(res, hint.client, { error: 'state_invalid' }, hint.agentCallbackScheme);
    return finish(res, 'dashboard', { error: 'state_invalid' });
  }
  const { client } = payload;
  const agentCallbackScheme = payload.agentCallbackScheme ?? 'grind';
  if (client === 'dashboard') clearStateCookie(res);

  try {
    if (req.query.error) return finish(res, client, { error: 'denied' }, agentCallbackScheme);
    if (!req.query.code) return finish(res, client, { error: 'invalid_request' }, agentCallbackScheme);
    if (!isLarkConfigured()) return finish(res, client, { error: 'config' }, agentCallbackScheme);

    // Dashboard CSRF: double-submit cookie must match the state nonce.
    if (client === 'dashboard') {
      const cookieNonce = (req.cookies as Record<string, string> | undefined)?.[STATE_COOKIE];
      if (!cookieNonce || cookieNonce !== payload.nonce) {
        return finish(res, client, { error: 'state_invalid' }, agentCallbackScheme);
      }
    }

    const tm = getTokenManager();
    const pc = getProfileClient();
    const cfg = getLarkConfig();
    if (!tm || !pc || !cfg.redirectUri) return finish(res, client, { error: 'config' }, agentCallbackScheme);

    // 1. Exchange code → tokens.
    let tokens;
    try {
      tokens = await tm.exchangeCode(String(req.query.code), cfg.redirectUri);
    } catch (err) {
      if (err instanceof LarkTransientError) return finish(res, client, { error: 'temporary' }, agentCallbackScheme);
      logger.warn({ err: String(err), nonce: payload.nonce }, 'lark login: code exchange failed');
      return finish(res, client, { error: 'auth_failed' }, agentCallbackScheme);
    }

    // 2. Fetch profile.
    const profile = await pc.getProfile(tokens.accessToken);
    if (!profile) return finish(res, client, { error: 'auth_failed' }, agentCallbackScheme);
    if (!profile.email) return finish(res, client, { error: 'no_email' }, agentCallbackScheme);

    // 3. Resolve / provision.
    const user = await resolveUser(profile);

    // 4. Persist Lark tokens before redirecting so login leaves task/approval
    // features connected. Failure is still non-terminal: the next login can
    // re-grant a fresh single-use refresh token.
    await tm
      .persistTokens(user.id, tokens)
      .catch((err) => logger.warn({ err: String(err), userId: user.id }, 'lark login: token persist failed'));

    if (user.deactivatedAt) return finish(res, client, { error: 'deactivated' }, agentCallbackScheme);
    if (user.provisioningStatus !== 'ACTIVE') return finish(res, client, { status: 'pending' }, agentCallbackScheme);

    // 5. Issue the Grind session.
    const accessToken = signAccessToken({ sub: user.id, ws: user.workspaceId, role: user.role });
    logger.info({ openId: profile.openId, userId: user.id, client }, 'lark login: session issued');

    if (client === 'agent') {
      const oneTime = await createAgentAuthCode(user.id, payload.agentChallenge ?? '');
      return res.redirect(`${agentCallbackScheme}://auth?code=${encodeURIComponent(oneTime)}`);
    }
    // Dashboard: issue a refresh token alongside the access cookie so the
    // session survives past the short access TTL via silent /refresh-cookie.
    const { refreshToken } = await issueRefreshToken(user.id, 'dashboard');
    setSessionCookie(res, accessToken);
    setRefreshCookie(res, refreshToken);
    return res.redirect(`${dashboardBase()}/`);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/auth/lark/exchange — agent redeems its one-time deep-link code
 * (PKCE-verified, single-use) for a Grind session.
 */
authLarkRouter.post('/exchange', validate(AgentLarkExchangeRequest, 'body'), async (req, res, next) => {
  try {
    const { code, codeVerifier } = req.body as AgentLarkExchangeRequest;
    let userId: string;
    try {
      userId = await redeemAgentAuthCode(code, codeVerifier);
    } catch (err) {
      if (err instanceof AgentCodeError) return res.status(400).json({ error: err.code });
      throw err;
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, workspaceId: true, role: true, deactivatedAt: true, provisioningStatus: true },
    });
    if (!user || user.deactivatedAt || user.provisioningStatus !== 'ACTIVE') {
      return res.status(403).json({ error: 'not_active' });
    }
    const accessToken = signAccessToken({ sub: user.id, ws: user.workspaceId, role: user.role });
    const { refreshToken } = await issueRefreshToken(user.id, 'agent');
    const response: AgentLarkExchangeResponse = {
      accessToken,
      refreshToken,
      userId: user.id,
      workspaceId: user.workspaceId,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default authLarkRouter;
