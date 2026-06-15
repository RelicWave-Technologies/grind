import { Router } from 'express';
import { prisma } from '@grind/db';
import {
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  RefreshRequest,
  RefreshResponse,
  Role as RoleSchema,
  roleCapabilities,
  type UserDto,
} from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { signAccessToken } from '../lib/jwt';
import { verifyPassword } from '../lib/password';
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken } from '../lib/refreshToken';
import {
  setSessionCookie,
  clearSessionCookie,
  setRefreshCookie,
  clearRefreshCookie,
  REFRESH_COOKIE,
} from '../lib/cookies';
import { env } from '../env';

export const authRouter = Router();

/**
 * DEV-ONLY email/password login. Lark OAuth is the sole identity in production;
 * this stays mounted only for local dev + the test suite (no live Lark tenant),
 * gated by NODE_ENV + an explicit flag so it can never be reached in prod.
 */
const PASSWORD_LOGIN_ENABLED = env.NODE_ENV !== 'production' && env.ALLOW_PASSWORD_LOGIN === 'true';

export type AuthUserRow = {
  id: string;
  email: string;
  name: string;
  role: unknown;
  workspaceId: string;
  teamId: string | null;
  managerId: string | null;
  provisioningStatus: 'PENDING' | 'ACTIVE';
  avatarUrl: string | null;
};

/** Minimal Prisma `select` that satisfies {@link serializeAuthUser}. */
export const AUTH_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  workspaceId: true,
  teamId: true,
  managerId: true,
  provisioningStatus: true,
  avatarUrl: true,
} as const;

export function serializeAuthUser(user: AuthUserRow): UserDto | null {
  const parsedRole = RoleSchema.safeParse(user.role);
  if (!parsedRole.success) return null;
  const role = parsedRole.data;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role,
    displayRole: role,
    capabilities: roleCapabilities(role),
    workspaceId: user.workspaceId,
    teamId: user.teamId,
    managerId: user.managerId,
    provisioningStatus: user.provisioningStatus,
    avatarUrl: user.avatarUrl,
  };
}

/**
 * DEV-ONLY login. Returns access + refresh tokens in the JSON body for the
 * agent AND sets the httpOnly dashboard cookie. Mounted only when the password
 * shim is enabled (never in production — Lark login replaces it).
 */
if (PASSWORD_LOGIN_ENABLED) {
  authRouter.post('/login', validate(LoginRequest, 'body'), async (req, res, next) => {
    try {
      const { email, password, deviceName } = req.body as LoginRequest;
      const user = await prisma.user.findUnique({ where: { email } });
      // passwordHash is nullable (Lark-only users have none) — missing = no password login.
      if (!user || !user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      // Deactivated users can't acquire sessions. (Provisioning status is a
      // Lark-flow concept; this dev-only shim doesn't gate on it.)
      if (user.deactivatedAt) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      const payloadUser = serializeAuthUser(user);
      if (!payloadUser) return res.status(503).json({ error: 'stale_role_migration_required' });

      const accessToken = signAccessToken({ sub: user.id, ws: user.workspaceId, role: payloadUser.role });
      const { refreshToken } = await issueRefreshToken(user.id, deviceName);
      setSessionCookie(res, accessToken);
      setRefreshCookie(res, refreshToken);

      const response: LoginResponse = { accessToken, refreshToken, user: payloadUser };
      res.json(response);
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Dashboard logout: revoke the refresh token server-side (so it can't be
 * rotated again) and clear both cookies. Best-effort revoke — clearing the
 * cookies is what actually logs the browser out. Agent uses /logout (refresh
 * token in body) instead.
 */
authRouter.post('/cookie-logout', async (req, res, next) => {
  try {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (presented) await revokeRefreshToken(presented);
    clearSessionCookie(res);
    clearRefreshCookie(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Echo the authed user — used by the dashboard on boot to verify the cookie. */
authRouter.get('/me', requireAccessToken, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: AUTH_USER_SELECT,
    });
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const payloadUser = serializeAuthUser(user);
    if (!payloadUser) return res.status(503).json({ error: 'stale_role_migration_required' });
    res.json({ user: payloadUser });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/auth/me/shift — the authed user's currently-assigned shift,
 * with full schedule + bufferMin. The agent calls this on boot and after
 * every `powerMonitor` resume to schedule the next "ready to work?" popup.
 * Returns `{ shift: null, assignedAt: null }` for unassigned users.
 */
authRouter.get('/me/shift', requireAccessToken, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const me = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { shiftId: true, shiftAssignedAt: true },
    });
    if (!me?.shiftId) return res.json({ shift: null, assignedAt: null });
    const s = await prisma.shift.findUnique({
      where: { id: me.shiftId },
      include: { members: { select: { id: true } } },
    });
    if (!s) return res.json({ shift: null, assignedAt: null });
    res.json({
      shift: {
        id: s.id,
        workspaceId: s.workspaceId,
        name: s.name,
        schedule: s.schedule,
        bufferMin: s.bufferMin,
        memberCount: s.members.length,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      },
      assignedAt: me.shiftAssignedAt ? me.shiftAssignedAt.toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Bearer-token refresh for the agent (and any non-browser client). Rotates the
 * refresh token in the request body with reuse detection and returns the new
 * pair as JSON. The dashboard uses /refresh-cookie instead (httpOnly cookies).
 */
authRouter.post('/refresh', validate(RefreshRequest, 'body'), async (req, res, next) => {
  try {
    const { refreshToken } = req.body as RefreshRequest;
    const result = await rotateRefreshToken(refreshToken);
    if (!result.ok) {
      if (result.reason === 'stale_role') return res.status(503).json({ error: 'stale_role_migration_required' });
      return res.status(401).json({ error: 'invalid_refresh' });
    }
    const response: RefreshResponse = { accessToken: result.accessToken, refreshToken: result.refreshToken };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * Cookie-based silent refresh for the dashboard. Reads the httpOnly grind_rt
 * cookie, rotates it (reuse detection), and re-sets both cookies. On any
 * failure it clears both cookies so the browser stops replaying a dead token
 * and the router falls through to /login. No body — the cookie is the credential.
 */
authRouter.post('/refresh-cookie', async (req, res, next) => {
  try {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!presented) return res.status(401).json({ error: 'no_refresh' });
    const result = await rotateRefreshToken(presented);
    if (!result.ok) {
      clearSessionCookie(res);
      clearRefreshCookie(res);
      if (result.reason === 'stale_role') return res.status(503).json({ error: 'stale_role_migration_required' });
      return res.status(401).json({ error: 'invalid_refresh', reason: result.reason });
    }
    setSessionCookie(res, result.accessToken);
    setRefreshCookie(res, result.refreshToken);
    res.json({ ok: true as const });
  } catch (err) {
    next(err);
  }
});

authRouter.post(
  '/logout',
  requireAccessToken,
  validate(LogoutRequest, 'body'),
  async (req, res, next) => {
    try {
      const { refreshToken } = req.body as LogoutRequest;
      await revokeRefreshToken(refreshToken);
      res.json({ ok: true as const });
    } catch (err) {
      next(err);
    }
  },
);
