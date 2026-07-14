import os from 'node:os';
import crypto from 'node:crypto';
import { shell } from 'electron';
import type { AgentLarkExchangeResponse, LoginResponse, LogoutResponse, UserDto } from '@grind/types';
import { api, UnauthorizedError } from './apiClient';
import { API_URL, CALLBACK_SCHEME } from '../env';
import { log } from '../logger';
import { clearTokens, loadTokens, saveTokens } from './tokenStore';
import {
  clearStoredPendingLarkLogin,
  loadPendingLarkLogin,
  savePendingLarkLogin,
  type StoredPendingLarkLogin,
} from './pendingLarkLoginStore';
import { clearWorkspaceTimeSession } from './workspaceTime';

/**
 * Lark login (system-browser + custom-scheme deep-link). We generate a PKCE
 * verifier, open the system browser at the API's /start, and hold the verifier
 * until the deep-link returns a one-time code. The verifier never leaves this
 * process, so a malicious app that intercepts the callback URL can't redeem the
 * code (the API checks sha256(verifier) == challenge).
 */
export const LARK_LOGIN_REUSE_TTL_MS = 9 * 60_000;
export const LARK_LOGIN_HARD_TTL_MS = 12 * 60_000;

type PendingLarkLogin = {
  verifier: string;
  loginUrl: string;
  createdAt: number;
  clearTimer: ReturnType<typeof setTimeout>;
};

let pendingLogin: PendingLarkLogin | null = null;

function toStored(login: PendingLarkLogin): StoredPendingLarkLogin {
  return { verifier: login.verifier, loginUrl: login.loginUrl, createdAt: login.createdAt };
}

function clearPendingLarkLoginMemory(): void {
  if (pendingLogin) clearTimeout(pendingLogin.clearTimer);
  pendingLogin = null;
}

async function clearPendingLarkLogin(): Promise<void> {
  clearPendingLarkLoginMemory();
  await clearStoredPendingLarkLogin();
}

function armExpiryTimer(verifier: string, createdAt: number): ReturnType<typeof setTimeout> {
  const remaining = Math.max(1, LARK_LOGIN_HARD_TTL_MS - (Date.now() - createdAt));
  const clearTimer = setTimeout(() => {
    if (pendingLogin?.verifier === verifier && pendingLogin.createdAt === createdAt) {
      pendingLogin = null;
      void clearStoredPendingLarkLogin();
    }
  }, remaining);
  clearTimer.unref?.();
  return clearTimer;
}

function createPendingLarkLogin(now = Date.now()): PendingLarkLogin {
  const verifier = crypto.randomBytes(48).toString('base64url'); // 64 chars (43-128 ok)
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    client: 'agent',
    code_challenge: challenge,
    callback_scheme: CALLBACK_SCHEME,
  });
  const loginUrl = `${API_URL}/v1/auth/lark/start?${params.toString()}`;
  const clearTimer = armExpiryTimer(verifier, now);
  return { verifier, loginUrl, createdAt: now, clearTimer };
}

function isReusable(login: PendingLarkLogin, now: number): boolean {
  return now - login.createdAt < LARK_LOGIN_REUSE_TTL_MS;
}

function isHardExpired(login: PendingLarkLogin, now: number): boolean {
  return now - login.createdAt >= LARK_LOGIN_HARD_TTL_MS;
}

async function getPendingLarkLogin(now = Date.now()): Promise<PendingLarkLogin | null> {
  if (pendingLogin) return pendingLogin;
  const stored = await loadPendingLarkLogin();
  if (!stored) return null;
  const login: PendingLarkLogin = { ...stored, clearTimer: armExpiryTimer(stored.verifier, stored.createdAt) };
  if (isHardExpired(login, now)) {
    clearPendingLarkLoginMemory();
    await clearStoredPendingLarkLogin();
    return null;
  }
  pendingLogin = login;
  return login;
}

/** Begin a Lark login: mint PKCE, open the browser. The deep-link finishes it. */
export async function startLarkLogin(): Promise<void> {
  const now = Date.now();
  let login = await getPendingLarkLogin(now);
  if (!login || !isReusable(login, now)) {
    await clearPendingLarkLogin();
    pendingLogin = createPendingLarkLogin(now);
    login = pendingLogin;
    await savePendingLarkLogin(toStored(login));
  }
  try {
    await shell.openExternal(login.loginUrl, { activate: true });
  } catch (err) {
    await clearPendingLarkLogin();
    log.warn('failed to open Lark login in browser', { err: String(err) });
    throw err;
  }
}

/** Redeem the deep-link one-time code for a session. Returns false if no login
 *  flow is in progress (stray/replayed deep-link) or the exchange fails. */
export async function completeLarkLogin(code: string): Promise<boolean> {
  const login = await getPendingLarkLogin();
  if (!login) return false;
  if (isHardExpired(login, Date.now())) {
    await clearPendingLarkLogin();
    return false;
  }
  const res = await api<AgentLarkExchangeResponse>('/v1/auth/lark/exchange', {
    method: 'POST',
    auth: false,
    body: { code, codeVerifier: login.verifier },
  });
  await saveTokens({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    userId: res.userId,
    workspaceId: res.workspaceId,
  });
  clearWorkspaceTimeSession();
  await clearPendingLarkLogin();
  return true;
}

/** Abandon an in-flight Lark login (e.g. the deep-link reported pending/error). */
export function cancelLarkLogin(): void {
  clearPendingLarkLoginMemory();
  void clearStoredPendingLarkLogin();
}

export async function login(email: string, password: string): Promise<UserDto> {
  const res = await api<LoginResponse>('/v1/auth/login', {
    method: 'POST',
    auth: false,
    body: { email, password, deviceName: `${os.hostname()} (${process.platform})` },
  });
  await saveTokens({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    userId: res.user.id,
    workspaceId: res.user.workspaceId,
  });
  clearWorkspaceTimeSession();
  return res.user;
}

export async function logout(): Promise<void> {
  const tokens = await loadTokens();
  if (tokens) {
    try {
      await api<LogoutResponse>('/v1/auth/logout', {
        method: 'POST',
        body: { refreshToken: tokens.refreshToken },
      });
    } catch {
      // best-effort; clear locally regardless
    }
  }
  await clearTokens();
  clearWorkspaceTimeSession();
}

export async function isLoggedIn(): Promise<boolean> {
  return ensureSession();
}

/**
 * Validate the locally saved session before falling back to OAuth.
 * `api()` silently rotates the refresh token on a 401, so a valid refresh token
 * keeps the user signed in across app restarts without reopening Lark.
 */
export async function ensureSession(): Promise<boolean> {
  const tokens = await loadTokens();
  if (!tokens) return false;
  try {
    await api('/v1/auth/me');
    return true;
  } catch (err) {
    if (err instanceof UnauthorizedError) return false;
    log.warn('session validation failed; keeping cached login state', { err: String(err) });
    return true;
  }
}
