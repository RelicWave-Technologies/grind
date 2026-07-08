import { createHash, randomBytes, timingSafeEqual } from 'crypto';

const TOKEN_PREFIX = 'timo_mcp_';

export interface GeneratedApiToken {
  publicId: string;
  tokenPrefix: string;
  rawToken: string;
  tokenHash: string;
}

export function hashApiToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function generateApiToken(): GeneratedApiToken {
  const publicId = `atk_${randomBytes(9).toString('base64url')}`;
  const secret = randomBytes(32).toString('base64url');
  const tokenPrefix = `${TOKEN_PREFIX}${publicId}`;
  const rawToken = `${tokenPrefix}.${secret}`;
  return {
    publicId,
    tokenPrefix,
    rawToken,
    tokenHash: hashApiToken(rawToken),
  };
}

export function parseApiToken(rawToken: string): { publicId: string } | null {
  const trimmed = rawToken.trim();
  const match = /^timo_mcp_(atk_[A-Za-z0-9_-]{12})\.[A-Za-z0-9_-]{32,}$/.exec(trimmed);
  if (!match?.[1]) return null;
  return { publicId: match[1] };
}

export function safeEqualHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
