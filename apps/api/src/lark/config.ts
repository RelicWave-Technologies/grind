import { env } from '../env';

/**
 * Lark scopes Timo requests. Mirrors the plan (§3.1). Kept here so the OAuth
 * authorize URL, the status endpoint, and tests all reference one list.
 */
export const LARK_SCOPES = [
  'task:task:read',
  'task:task:write',
  'task:tasklist:read',
  'calendar:calendar:readonly',
  'calendar:calendar.free_busy:read',
  'vc:meeting:readonly',
  'im:message:send_as_bot',
  'im:message:update',
  'im:message:readonly',
  'im:message.group_at_msg:readonly',
  'im:chat:read',
  'contact:user.id:readonly',
  'contact:user.employee_id:readonly',
  // Required so /authen/v1/user_info returns email/enterprise_email — the
  // canonical identifier Timo matches on at login.
  'contact:user.email:readonly',
  'offline_access',
] as const;

export const LARK_SCOPE_STRING = LARK_SCOPES.join(' ');

export type LarkConfig = {
  appId: string;
  appSecret: string;
  tokenKey: string;
  oauthHost: string;
  accountsHost: string;
  loginRedirectUri?: string;
  connectRedirectUri?: string;
};

function matchesCallbackPath(value: string | undefined, suffix: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.pathname.endsWith(suffix) ? value : undefined;
  } catch {
    return undefined;
  }
}

function larkEnv() {
  const legacyRedirectUri = process.env.LARK_OAUTH_REDIRECT_URI || env.LARK_OAUTH_REDIRECT_URI;
  return {
    appId: process.env.LARK_APP_ID || env.LARK_APP_ID,
    appSecret: process.env.LARK_APP_SECRET || env.LARK_APP_SECRET,
    tokenKey: process.env.LARK_TOKEN_KEY || env.LARK_TOKEN_KEY,
    oauthHost: process.env.LARK_OAUTH_HOST || env.LARK_OAUTH_HOST,
    accountsHost: process.env.LARK_ACCOUNTS_HOST || env.LARK_ACCOUNTS_HOST,
    loginRedirectUri:
      process.env.LARK_LOGIN_REDIRECT_URI ||
      env.LARK_LOGIN_REDIRECT_URI ||
      matchesCallbackPath(legacyRedirectUri, '/v1/auth/lark/callback'),
    connectRedirectUri:
      process.env.LARK_CONNECT_REDIRECT_URI ||
      env.LARK_CONNECT_REDIRECT_URI ||
      matchesCallbackPath(legacyRedirectUri, '/v1/lark/oauth/callback'),
  };
}

function hasCredentialValues(cfg: ReturnType<typeof larkEnv>): boolean {
  return Boolean(cfg.appId && cfg.appSecret && cfg.tokenKey);
}

export function hasLarkCredentials(): boolean {
  return hasCredentialValues(larkEnv());
}

/**
 * True only when every credential needed to run task-connect OAuth is present.
 * The integration is disabled (not crashing) when creds are missing, so the
 * rest of the API runs fine in dev/CI without Lark configured.
 */
export function isLarkConfigured(): boolean {
  const cfg = larkEnv();
  return hasCredentialValues(cfg) && Boolean(cfg.connectRedirectUri);
}

export function isLarkLoginConfigured(): boolean {
  const cfg = larkEnv();
  return hasCredentialValues(cfg) && Boolean(cfg.loginRedirectUri);
}

/**
 * Returns the validated Lark config, or throws if not fully configured.
 * Call sites that are reachable only when {@link isLarkConfigured} is true
 * can rely on this never throwing.
 */
export function getLarkConfig(): LarkConfig {
  const cfg = larkEnv();
  if (!cfg.appId || !cfg.appSecret || !cfg.tokenKey) {
    throw new Error('Lark is not configured (set LARK_APP_ID, LARK_APP_SECRET, LARK_TOKEN_KEY)');
  }
  return {
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    tokenKey: cfg.tokenKey,
    oauthHost: cfg.oauthHost,
    accountsHost: cfg.accountsHost,
    loginRedirectUri: cfg.loginRedirectUri,
    connectRedirectUri: cfg.connectRedirectUri,
  };
}
