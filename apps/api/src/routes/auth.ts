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
import { issueRefreshToken, revokeRefreshToken, sha256 } from '../lib/refreshToken';

export const authRouter = Router();

type AuthUserRow = {
  id: string;
  email: string;
  name: string;
  role: unknown;
  workspaceId: string;
  teamId: string | null;
  managerId: string | null;
};

function serializeAuthUser(user: AuthUserRow): UserDto | null {
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
  };
}

/**
 * Login. Returns access + refresh tokens in the JSON body for the agent
 * (which stores them locally), AND sets an httpOnly cookie carrying the
 * access token for the dashboard. The middleware accepts either source.
 */
authRouter.post('/login', validate(LoginRequest, 'body'), async (req, res, next) => {
  try {
    const { email, password, deviceName } = req.body as LoginRequest;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(user.passwordHash, password))) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    // Deactivated users can't acquire fresh sessions. They get the same
    // generic error as a bad password so the response surface doesn't
    // leak account state to outsiders.
    if (user.deactivatedAt) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const payloadUser = serializeAuthUser(user);
    if (!payloadUser) return res.status(503).json({ error: 'stale_role_migration_required' });

    const accessToken = signAccessToken({ sub: user.id, ws: user.workspaceId, role: payloadUser.role });
    const { refreshToken } = await issueRefreshToken(user.id, deviceName);

    // In production the dashboard (Vercel) and API (Render) live on different
    // sites, so the cookie must be SameSite=None + Secure to travel on the
    // dashboard's credentialed fetches. In dev they share localhost → Lax.
    const crossSite = process.env.NODE_ENV === 'production';
    res.cookie('grind_at', accessToken, {
      httpOnly: true,
      sameSite: crossSite ? 'none' : 'lax',
      secure: crossSite,
      maxAge: 60 * 60 * 1000, // 1h, matches the JWT TTL
      path: '/',
    });

    const response: LoginResponse = {
      accessToken,
      refreshToken,
      user: payloadUser,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * Clear the dashboard's access cookie. Agent uses /logout (with refresh
 * token in body) which also revokes the refresh token — that path is
 * unchanged.
 */
authRouter.post('/cookie-logout', (_req, res) => {
  const crossSite = process.env.NODE_ENV === 'production';
  res.clearCookie('grind_at', {
    path: '/',
    sameSite: crossSite ? 'none' : 'lax',
    secure: crossSite,
  });
  res.json({ ok: true });
});

/** Echo the authed user — used by the dashboard on boot to verify the cookie. */
authRouter.get('/me', requireAccessToken, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: {
        id: true, email: true, name: true, role: true, workspaceId: true,
        teamId: true, managerId: true,
      },
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

authRouter.post('/refresh', validate(RefreshRequest, 'body'), async (req, res, next) => {
  try {
    const { refreshToken } = req.body as RefreshRequest;
    const tokenHash = sha256(refreshToken);
    const row = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      return res.status(401).json({ error: 'invalid_refresh' });
    }
    await prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    const parsedRole = RoleSchema.safeParse(row.user.role);
    if (!parsedRole.success) return res.status(503).json({ error: 'stale_role_migration_required' });
    const accessToken = signAccessToken({
      sub: row.userId,
      ws: row.user.workspaceId,
      role: parsedRole.data,
    });
    const fresh = await issueRefreshToken(row.userId, row.deviceName ?? undefined);
    const response: RefreshResponse = { accessToken, refreshToken: fresh.refreshToken };
    res.json(response);
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
