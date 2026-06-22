import crypto from 'node:crypto';
import { prisma } from '@grind/db';
import { Role as RoleSchema } from '@grind/types';
import { env } from '../env';
import { signAccessToken } from './jwt';

export type IssuedRefresh = {
  refreshToken: string;
  expiresAt: Date;
  familyId: string;
};

// Browser tabs can hit the 15-minute access-token expiry at the same time.
// One tab rotates the cookie refresh token; another may replay the just-spent
// token milliseconds later before the shared cookie jar settles. Treat that as
// benign for a tiny window instead of revoking the whole family.
export const REFRESH_REUSE_GRACE_MS = 30_000;

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function newSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
}

/**
 * Mint a brand-new refresh token that starts its own rotation family. Used on
 * fresh logins (Lark callback, agent exchange, dev password). Subsequent
 * rotations go through {@link rotateRefreshToken} and stay in the same family.
 */
export async function issueRefreshToken(userId: string, deviceName?: string): Promise<IssuedRefresh> {
  const refreshToken = newSecret();
  const tokenHash = sha256(refreshToken);
  const expiresAt = refreshExpiry();
  // A fresh login starts its own family; familyId is set to the row id post-create.
  const row = await prisma.refreshToken.create({
    data: { userId, tokenHash, deviceName: deviceName ?? null, familyId: 'pending', expiresAt },
  });
  await prisma.refreshToken.update({ where: { id: row.id }, data: { familyId: row.id } });
  return { refreshToken, expiresAt, familyId: row.id };
}

export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  const tokenHash = sha256(refreshToken);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!row || row.revokedAt) return false;
  await prisma.refreshToken.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
  });
  return true;
}

export type RotateResult =
  | { ok: true; accessToken: string; refreshToken: string; expiresAt: Date }
  | { ok: false; reason: 'invalid' | 'expired' | 'reuse' | 'reuse_grace' | 'stale_role' };

/**
 * Single-use rotation with reuse detection. Validates the presented token,
 * revokes it, and mints a successor in the SAME family — all in one
 * transaction so concurrent rotations can't both succeed.
 *
 * If an ALREADY-REVOKED token is presented, that's a replay (a stolen token, or
 * a client that double-spent): we revoke every live token in the family and
 * reject. The legitimate client's current token dies too, forcing a clean
 * re-login — the safe response to a possible theft.
 */
export async function rotateRefreshToken(presented: string): Promise<RotateResult> {
  const tokenHash = sha256(presented);
  return prisma.$transaction(async (tx): Promise<RotateResult> => {
    const row = await tx.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!row) return { ok: false, reason: 'invalid' };

    if (row.revokedAt) {
      const liveSuccessor = await tx.refreshToken.findFirst({
        where: {
          familyId: row.familyId,
          revokedAt: null,
          createdAt: { gte: row.revokedAt },
        },
        select: { id: true },
      });
      if (liveSuccessor && Date.now() - row.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS) {
        return { ok: false, reason: 'reuse_grace' };
      }
      // Reuse detected → nuke the whole family.
      await tx.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { ok: false, reason: 'reuse' };
    }
    if (row.expiresAt < new Date()) return { ok: false, reason: 'expired' };

    const parsedRole = RoleSchema.safeParse(row.user.role);
    if (!parsedRole.success) return { ok: false, reason: 'stale_role' };

    // Revoke the presented token, mint its successor in the same family.
    await tx.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    const refreshToken = newSecret();
    const expiresAt = refreshExpiry();
    await tx.refreshToken.create({
      data: {
        userId: row.userId,
        tokenHash: sha256(refreshToken),
        deviceName: row.deviceName,
        familyId: row.familyId,
        expiresAt,
      },
    });

    const accessToken = signAccessToken({
      sub: row.userId,
      ws: row.user.workspaceId,
      role: parsedRole.data,
    });
    return { ok: true, accessToken, refreshToken, expiresAt };
  });
}
