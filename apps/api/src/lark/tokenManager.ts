import type { PrismaClient } from '@grind/db';
import { encryptToken, decryptToken } from './crypto';
import {
  type OAuthClient,
  type LarkTokenResponse,
  LarkReauthRequiredError,
  LarkTransientError,
} from './oauthClient';
import { LARK_SCOPES } from './config';

/**
 * TokenManager — owns Lark OAuth tokens server-side.
 *
 * The #1 production foot-gun (per research): Lark refresh tokens are
 * SINGLE-USE with a 7-day TTL. Every refresh returns a new refresh token and
 * invalidates the old one. If we use the access token but fail to persist the
 * rotated refresh token, the user is bricked until they reconnect.
 *
 * Invariants enforced here:
 *  1. The rotated refresh token is persisted (encrypted) BEFORE the access
 *     token is handed to any caller.
 *  2. Refreshes are serialized per user (in-process lock) so two concurrent
 *     callers can't both spend the same single-use token.
 *  3. Any refresh/persist failure sets `reauthRequired=true` and surfaces a
 *     LarkReauthRequiredError — never a silent half-rotated state.
 *
 * Access tokens are cached in memory (short-lived, ~2h) and never persisted,
 * so the steady state does not burn a refresh token on every call.
 */

export type Clock = () => number;

export type CachedAccess = { token: string; expiresAtMs: number };

export type ConnectionStatus = {
  connected: boolean;
  reauthRequired: boolean;
  scopes: string[];
  missingScopes: string[];
  refreshExpiresAt: Date | null;
  lastRefreshedAt: Date | null;
};

// Refresh a bit early so an in-flight request never races token expiry.
const ACCESS_SKEW_MS = 60_000;

function missingRequiredScopes(scopes: string): string[] {
  const granted = new Set(scopes.split(' ').filter(Boolean));
  return LARK_SCOPES.filter((scope) => !granted.has(scope));
}

export class TokenManager {
  private readonly accessCache = new Map<string, CachedAccess>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      client: OAuthClient;
      tokenKey: string;
      now?: Clock;
    },
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Serialize work per user so single-use refresh tokens are never double-spent. */
  private async withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(userId, prev.then(() => next));
    await prev.catch(() => {}); // wait our turn; ignore prior errors
    try {
      return await fn();
    } finally {
      release();
      // Clean up if we're the tail of the chain.
      if (this.locks.get(userId) === prev.then(() => next)) this.locks.delete(userId);
    }
  }

  /** Persist a freshly-issued token pair (encrypting the refresh token). */
  private async persist(userId: string, res: LarkTokenResponse): Promise<void> {
    const refreshExpiresAt = new Date(this.now() + res.refreshExpiresInSec * 1000);
    const refreshTokenEnc = encryptToken(res.refreshToken, this.deps.tokenKey);
    const data = {
      refreshTokenEnc,
      refreshExpiresAt,
      scopes: res.scope,
      reauthRequired: false,
      lastRefreshedAt: new Date(this.now()),
    };
    await this.deps.prisma.larkOAuthToken.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    this.accessCache.set(userId, {
      token: res.accessToken,
      expiresAtMs: this.now() + res.accessExpiresInSec * 1000,
    });
  }

  /** Exchange an authorization code for the first token pair and store it. */
  async connect(userId: string, code: string, redirectUri: string): Promise<void> {
    await this.withLock(userId, async () => {
      const res = await this.deps.client.exchangeCode(code, redirectUri);
      await this.persist(userId, res);
    });
  }

  /**
   * Exchange an authorization code for a token pair WITHOUT persisting. Used by
   * Lark *login*, where the Grind user id isn't known until the profile is
   * fetched from the returned access token. Persist afterwards via
   * {@link persistTokens}. Propagates LarkTransientError / LarkReauthRequiredError.
   */
  async exchangeCode(code: string, redirectUri: string): Promise<LarkTokenResponse> {
    return this.deps.client.exchangeCode(code, redirectUri);
  }

  /**
   * Store an already-exchanged token pair for a user (serialized per user).
   * Lark login calls this once the user is resolved/created. Best-effort at the
   * call site: a failure here doesn't block the Grind session (the next login
   * re-grants a fresh single-use refresh token).
   */
  async persistTokens(userId: string, res: LarkTokenResponse): Promise<void> {
    await this.withLock(userId, async () => {
      await this.persist(userId, res);
    });
  }

  /** Mark a user as needing reconnection (e.g. after an unrecoverable error). */
  private async markReauth(userId: string): Promise<void> {
    this.accessCache.delete(userId);
    await this.deps.prisma.larkOAuthToken
      .update({ where: { userId }, data: { reauthRequired: true } })
      .catch(() => {});
  }

  /**
   * Return a valid Lark user access token, rotating the single-use refresh
   * token if needed. Throws LarkReauthRequiredError if the user must reconnect.
   */
  async getAccessToken(userId: string): Promise<string> {
    const cached = this.accessCache.get(userId);
    if (cached && cached.expiresAtMs - ACCESS_SKEW_MS > this.now()) {
      return cached.token;
    }
    return this.withLock(userId, async () => {
      // Re-check cache: a concurrent caller may have refreshed while we waited.
      const fresh = this.accessCache.get(userId);
      if (fresh && fresh.expiresAtMs - ACCESS_SKEW_MS > this.now()) return fresh.token;

      const row = await this.deps.prisma.larkOAuthToken.findUnique({ where: { userId } });
      if (!row) throw new LarkReauthRequiredError('Lark not connected for this user');
      if (row.reauthRequired) throw new LarkReauthRequiredError();
      if (missingRequiredScopes(row.scopes).length > 0) {
        await this.markReauth(userId);
        throw new LarkReauthRequiredError('Lark connection is missing required scopes');
      }
      if (row.refreshExpiresAt.getTime() <= this.now()) {
        await this.markReauth(userId);
        throw new LarkReauthRequiredError('Lark refresh token expired');
      }

      let oldRefresh: string;
      try {
        oldRefresh = decryptToken(row.refreshTokenEnc, this.deps.tokenKey);
      } catch {
        await this.markReauth(userId);
        throw new LarkReauthRequiredError('stored Lark token could not be decrypted');
      }

      let res: LarkTokenResponse;
      try {
        res = await this.deps.client.refresh(oldRefresh);
      } catch (err) {
        // Transient transport failure (network blip, Lark 5xx/429): the refresh
        // token wasn't consumed, so DON'T force a reconnect — surface it and let
        // a later call retry. Only an explicit rejection means reauth.
        if (err instanceof LarkTransientError) throw err;
        await this.markReauth(userId);
        if (err instanceof LarkReauthRequiredError) throw err;
        throw new LarkReauthRequiredError('Lark refresh failed');
      }

      // CRITICAL: persist the rotated refresh token BEFORE returning the
      // access token. If this throws, the rotation is lost → force reconnect.
      try {
        await this.persist(userId, res);
      } catch {
        await this.markReauth(userId);
        throw new LarkReauthRequiredError('failed to persist rotated Lark token');
      }
      return res.accessToken;
    });
  }

  /** Read-only connection status for the /v1/lark/status endpoint. */
  async getStatus(userId: string): Promise<ConnectionStatus> {
    const row = await this.deps.prisma.larkOAuthToken.findUnique({ where: { userId } });
    if (!row) {
      return {
        connected: false,
        reauthRequired: false,
        scopes: [],
        missingScopes: [],
        refreshExpiresAt: null,
        lastRefreshedAt: null,
      };
    }
    const expired = row.refreshExpiresAt.getTime() <= this.now();
    const missingScopes = missingRequiredScopes(row.scopes);
    return {
      connected: !row.reauthRequired && !expired && missingScopes.length === 0,
      reauthRequired: row.reauthRequired || expired || missingScopes.length > 0,
      scopes: row.scopes ? row.scopes.split(' ').filter(Boolean) : [],
      missingScopes,
      refreshExpiresAt: row.refreshExpiresAt,
      lastRefreshedAt: row.lastRefreshedAt,
    };
  }

  /** Forget a user's tokens (disconnect). */
  async disconnect(userId: string): Promise<void> {
    this.accessCache.delete(userId);
    await this.deps.prisma.larkOAuthToken.deleteMany({ where: { userId } });
  }
}
