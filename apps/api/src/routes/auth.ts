import { Router } from 'express';
import { prisma } from '@grind/db';
import {
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  RefreshRequest,
  RefreshResponse,
} from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { signAccessToken } from '../lib/jwt';
import { verifyPassword } from '../lib/password';
import { issueRefreshToken, revokeRefreshToken, sha256 } from '../lib/refreshToken';

export const authRouter = Router();

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
    const accessToken = signAccessToken({ sub: user.id, ws: user.workspaceId, role: user.role });
    const { refreshToken } = await issueRefreshToken(user.id, deviceName);

    res.cookie('grind_at', accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 1000, // 1h, matches the JWT TTL
      path: '/',
    });

    const response: LoginResponse = {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        workspaceId: user.workspaceId,
      },
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
  res.clearCookie('grind_at', { path: '/' });
  res.json({ ok: true });
});

/** Echo the authed user — used by the dashboard on boot to verify the cookie. */
authRouter.get('/me', requireAccessToken, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { id: true, email: true, name: true, role: true, workspaceId: true },
    });
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    res.json({ user });
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
    const accessToken = signAccessToken({
      sub: row.userId,
      ws: row.user.workspaceId,
      role: row.user.role,
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
