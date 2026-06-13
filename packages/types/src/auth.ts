import { z } from 'zod';

export const Role = z.enum(['ADMIN', 'MANAGER', 'MEMBER']);
export type Role = z.infer<typeof Role>;

/** JIT-provisioning lifecycle for Lark-authenticated users. */
export const ProvisioningStatus = z.enum(['PENDING', 'ACTIVE']);
export type ProvisioningStatus = z.infer<typeof ProvisioningStatus>;

export const UserDto = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: Role,
  displayRole: Role,
  capabilities: z.array(z.string()),
  workspaceId: z.string(),
  teamId: z.string().nullable(),
  managerId: z.string().nullable(),
  provisioningStatus: ProvisioningStatus,
  avatarUrl: z.string().nullable(),
});
export type UserDto = z.infer<typeof UserDto>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  deviceName: z.string().max(100).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: UserDto,
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const RefreshRequest = z.object({
  refreshToken: z.string(),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const RefreshResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type RefreshResponse = z.infer<typeof RefreshResponse>;

export const LogoutRequest = z.object({
  refreshToken: z.string(),
});
export type LogoutRequest = z.infer<typeof LogoutRequest>;

export const LogoutResponse = z.object({
  ok: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponse>;

// --- Lark OAuth login -------------------------------------------------------

/** Client surface initiating a Lark login (drives session-delivery + CSRF). */
export const LarkLoginClient = z.enum(['dashboard', 'agent']);
export type LarkLoginClient = z.infer<typeof LarkLoginClient>;

/**
 * Terminal outcomes surfaced to the UI as `?error=`/`?status=` on the login
 * route (dashboard) or `grind://auth?...` (agent). Kept as a closed set so both
 * clients render consistent, friendly copy.
 */
export const LarkLoginOutcome = z.enum([
  'pending', // user provisioned, awaiting admin activation
  'denied', // user declined consent on Lark
  'invalid_request', // missing code/state
  'state_invalid', // forged/expired state or CSRF cookie mismatch
  'temporary', // transient Lark/network failure — safe to retry
  'auth_failed', // code exchange / token error
  'no_email', // Lark profile had no email (scope not granted)
  'deactivated', // user exists but is deactivated
  'config', // Lark not configured on the server
]);
export type LarkLoginOutcome = z.infer<typeof LarkLoginOutcome>;

/** Agent redeems its one-time deep-link code for a Grind session. */
export const AgentLarkExchangeRequest = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(43).max(128),
});
export type AgentLarkExchangeRequest = z.infer<typeof AgentLarkExchangeRequest>;

export const AgentLarkExchangeResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  userId: z.string(),
  workspaceId: z.string(),
});
export type AgentLarkExchangeResponse = z.infer<typeof AgentLarkExchangeResponse>;
