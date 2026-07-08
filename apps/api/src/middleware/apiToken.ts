import type { RequestHandler } from 'express';
import { prisma } from '@grind/db';
import {
  API_TOKEN_SCOPES,
  type ApiTokenScope,
} from '@grind/types';
import { hashApiToken, parseApiToken, safeEqualHash } from '../lib/apiTokens';

const VALID_SCOPES = new Set<string>(API_TOKEN_SCOPES);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiToken?: {
        id: string;
        workspaceId: string;
        createdById: string;
        scopes: ApiTokenScope[];
      };
    }
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function normalizeScopes(scopes: string[]): ApiTokenScope[] {
  return scopes.filter((scope): scope is ApiTokenScope => VALID_SCOPES.has(scope));
}

export function requireApiToken(requiredScopes: readonly ApiTokenScope[]): RequestHandler {
  return async (req, res, next) => {
    const rawToken = extractBearerToken(req.headers.authorization);
    if (!rawToken) return res.status(401).json({ error: 'missing_api_token' });

    const parsed = parseApiToken(rawToken);
    if (!parsed) return res.status(401).json({ error: 'invalid_api_token' });

    try {
      const token = await prisma.apiToken.findUnique({
        where: { publicId: parsed.publicId },
        select: {
          id: true,
          workspaceId: true,
          createdById: true,
          tokenHash: true,
          scopes: true,
          revokedAt: true,
          createdBy: {
            select: {
              role: true,
              deactivatedAt: true,
              provisioningStatus: true,
            },
          },
        },
      });

      const isUsable =
        token &&
        token.revokedAt === null &&
        token.createdBy.role === 'ADMIN' &&
        token.createdBy.deactivatedAt === null &&
        token.createdBy.provisioningStatus === 'ACTIVE' &&
        safeEqualHash(hashApiToken(rawToken), token.tokenHash);

      if (!isUsable) return res.status(401).json({ error: 'invalid_api_token' });

      const scopes = normalizeScopes(token.scopes);
      if (!requiredScopes.every((scope) => scopes.includes(scope))) {
        return res.status(403).json({ error: 'insufficient_scope' });
      }

      req.apiToken = {
        id: token.id,
        workspaceId: token.workspaceId,
        createdById: token.createdById,
        scopes,
      };

      await prisma.apiToken.updateMany({
        where: { id: token.id, revokedAt: null },
        data: {
          lastUsedAt: new Date(),
          lastUsedIp: req.ip,
        },
      });

      next();
    } catch (err) {
      next(err);
    }
  };
}
