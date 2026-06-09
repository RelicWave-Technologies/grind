import jwt from 'jsonwebtoken';
import { Role, type Role as RoleType } from '@grind/types';
import { env } from '../env';

export type AccessTokenPayload = {
  sub: string;
  ws: string;
  role: RoleType;
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  if (typeof decoded === 'string' || !decoded || typeof decoded !== 'object') {
    throw new Error('Invalid token payload');
  }
  const { sub, ws, role } = decoded as Record<string, unknown>;
  if (typeof sub !== 'string' || typeof ws !== 'string' || typeof role !== 'string') {
    throw new Error('Malformed access token');
  }
  const parsed = Role.safeParse(role);
  if (!parsed.success) {
    throw new Error('Invalid access token role');
  }
  return { sub, ws, role: parsed.data };
}
