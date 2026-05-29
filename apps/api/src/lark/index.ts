import { prisma } from '@grind/db';
import { isLarkConfigured, getLarkConfig } from './config';
import { TokenManager } from './tokenManager';
import { HttpOAuthClient } from './oauthClient';

export { isLarkConfigured, getLarkConfig, LARK_SCOPES, LARK_SCOPE_STRING } from './config';
export { TokenManager } from './tokenManager';
export { LarkReauthRequiredError } from './oauthClient';
export type { OAuthClient, LarkTokenResponse } from './oauthClient';

let manager: TokenManager | null = null;

/**
 * Returns the process-wide TokenManager, constructed lazily once Lark is
 * configured. Returns null when creds are absent so callers can degrade
 * gracefully instead of crashing.
 */
export function getTokenManager(): TokenManager | null {
  if (!isLarkConfigured()) return null;
  if (!manager) {
    manager = new TokenManager({
      prisma,
      client: new HttpOAuthClient(),
      tokenKey: getLarkConfig().tokenKey,
    });
  }
  return manager;
}
