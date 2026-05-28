import crypto from 'node:crypto';
import { prisma } from '@grind/db';
import { env } from '../env';

export type IssuedRefresh = {
  refreshToken: string;
  expiresAt: Date;
};

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export async function issueRefreshToken(userId: string, deviceName?: string): Promise<IssuedRefresh> {
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(refreshToken);
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);

  await prisma.refreshToken.create({
    data: { userId, tokenHash, deviceName: deviceName ?? null, expiresAt },
  });

  return { refreshToken, expiresAt };
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
