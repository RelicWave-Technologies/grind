import { prisma } from '@grind/db';
import { isLarkConfigured, getLarkConfig } from './config';
import { TokenManager } from './tokenManager';
import { HttpOAuthClient } from './oauthClient';
import { HttpTenantClient, type TenantClient } from './identity';
import { HttpUserTaskClient, type UserTaskClient } from './tasks';
import { HttpLarkMessenger, type LarkMessenger } from './messenger';

export { isLarkConfigured, getLarkConfig, LARK_SCOPES, LARK_SCOPE_STRING } from './config';
export { TokenManager } from './tokenManager';
export { LarkReauthRequiredError } from './oauthClient';
export type { OAuthClient, LarkTokenResponse } from './oauthClient';
export { resolveIdentity } from './identity';
export type { TenantClient, ResolvedLarkUser } from './identity';
export { signOAuthState, verifyOAuthState, buildAuthorizeUrl } from './oauth';
export { mapTasks, loggedMsByGuid, toEpochMs } from './tasks';
export type { UserTaskClient, LarkTaskDto, CreateLarkTaskInput } from './tasks';
export { buildApprovalCard, buildDecidedCard, buildSupersededCard, buildUpdatedApprovalCard } from './cards';
export { decideRequest } from './decide';
export { startCardCallback } from './cardCallback';
export type { ApprovalCardInput, DecidedCardInput, ApprovalAction, SupersededCardInput, UpdatedApprovalCardInput, DiffEntry } from './cards';
export type { LarkMessenger, SendCardResult } from './messenger';

let manager: TokenManager | null = null;
let tenant: TenantClient | null = null;
let taskClient: UserTaskClient | null = null;
let messenger: LarkMessenger | null = null;
let messengerOverride: LarkMessenger | null = null;

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

/** Process-wide tenant client (email→open_id), lazily built once configured. */
export function getTenantClient(): TenantClient | null {
  if (!isLarkConfigured()) return null;
  if (!tenant) tenant = new HttpTenantClient();
  return tenant;
}

/** Process-wide user-task client (my_tasks), lazily built once configured. */
export function getUserTaskClient(): UserTaskClient | null {
  if (!isLarkConfigured()) return null;
  if (!taskClient) taskClient = new HttpUserTaskClient();
  return taskClient;
}

/**
 * Process-wide IM messenger for sending approval cards. Tests inject a Fake
 * via {@link setLarkMessengerForTests} so route logic can be exercised without
 * hitting Lark; production returns null if Lark isn't configured so the route
 * can degrade gracefully.
 */
export function getLarkMessenger(): LarkMessenger | null {
  if (messengerOverride) return messengerOverride;
  if (!isLarkConfigured()) return null;
  if (!messenger) messenger = new HttpLarkMessenger();
  return messenger;
}

export function setLarkMessengerForTests(m: LarkMessenger | null): void {
  messengerOverride = m;
}
