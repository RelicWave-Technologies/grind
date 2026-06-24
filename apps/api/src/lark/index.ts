import { prisma } from '@grind/db';
import { isLarkConfigured, getLarkConfig } from './config';
import { TokenManager } from './tokenManager';
import { HttpOAuthClient } from './oauthClient';
import { HttpTenantClient, type TenantClient } from './identity';
import { HttpUserTaskClient, type UserTaskClient } from './tasks';
import { HttpLarkMessenger, type LarkMessenger } from './messenger';
import { HttpProfileClient, type ProfileClient } from './profile';

export { isLarkConfigured, getLarkConfig, LARK_SCOPES, LARK_SCOPE_STRING } from './config';
export { TokenManager } from './tokenManager';
export { LarkReauthRequiredError, LarkTransientError } from './oauthClient';
export type { OAuthClient, LarkTokenResponse } from './oauthClient';
export { resolveIdentity } from './identity';
export type { TenantClient, ResolvedLarkUser } from './identity';
export { signOAuthState, verifyOAuthState, buildAuthorizeUrl, signLoginState, verifyLoginState } from './oauth';
export type { LarkLoginStatePayload } from './oauth';
export type { ProfileClient, LarkProfile } from './profile';
export { normalizeEmail } from './profile';
export { mapTasks, loggedMsByGuid, toEpochMs, buildCreateTaskPayload, LarkTaskApiError } from './tasks';
export type { UserTaskClient, LarkTaskDto, CreateLarkTaskInput } from './tasks';
export { buildApprovalCard, buildDecidedCard, buildSupersededCard, buildUpdatedApprovalCard, buildCancelledCard } from './cards';
export { decideRequest } from './decide';
export { startCardCallback } from './cardCallback';
export type { ApprovalCardInput, DecidedCardInput, ApprovalAction, SupersededCardInput, UpdatedApprovalCardInput, DiffEntry, CancelledCardInput } from './cards';
export type { LarkMessenger, SendCardResult } from './messenger';

let manager: TokenManager | null = null;
let managerOverride: TokenManager | null = null;
let tenant: TenantClient | null = null;
let taskClient: UserTaskClient | null = null;
let messenger: LarkMessenger | null = null;
let messengerOverride: LarkMessenger | null = null;
let profileClient: ProfileClient | null = null;
let profileOverride: ProfileClient | null = null;

/**
 * Returns the process-wide TokenManager, constructed lazily once Lark is
 * configured. Returns null when creds are absent so callers can degrade
 * gracefully instead of crashing.
 */
export function getTokenManager(): TokenManager | null {
  if (managerOverride) return managerOverride;
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

/** Inject a TokenManager (built around a fake OAuthClient) for route tests. */
export function setTokenManagerForTests(m: TokenManager | null): void {
  managerOverride = m;
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

/**
 * Process-wide profile client (GET /authen/v1/user_info), used by Lark login to
 * read the signed-in user's identity. Tests inject a fake. Returns null when
 * Lark isn't configured so the login route degrades to a 503.
 */
export function getProfileClient(): ProfileClient | null {
  if (profileOverride) return profileOverride;
  if (!isLarkConfigured()) return null;
  if (!profileClient) profileClient = new HttpProfileClient();
  return profileClient;
}

export function setProfileClientForTests(p: ProfileClient | null): void {
  profileOverride = p;
}
