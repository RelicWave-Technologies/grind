import os from 'node:os';
import crypto from 'node:crypto';
import { shell } from 'electron';
import type { AgentLarkExchangeResponse, LoginResponse, LogoutResponse, UserDto } from '@grind/types';
import { api } from './apiClient';
import { API_URL } from '../env';
import { clearTokens, loadTokens, saveTokens } from './tokenStore';

/**
 * Lark login (system-browser + grind:// deep-link). We generate a PKCE
 * verifier, open the system browser at the API's /start, and hold the verifier
 * until the deep-link returns a one-time code. The verifier never leaves this
 * process, so a malicious app that intercepts the grind:// URL can't redeem the
 * code (the API checks sha256(verifier) == challenge).
 */
let pendingVerifier: string | null = null;

/** Begin a Lark login: mint PKCE, open the browser. The deep-link finishes it. */
export function startLarkLogin(): void {
  const verifier = crypto.randomBytes(48).toString('base64url'); // 64 chars (43–128 ok)
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  pendingVerifier = verifier;
  const url = `${API_URL}/v1/auth/lark/start?client=agent&code_challenge=${encodeURIComponent(challenge)}`;
  void shell.openExternal(url);
}

/** Redeem the deep-link one-time code for a session. Returns false if no login
 *  flow is in progress (stray/replayed deep-link) or the exchange fails. */
export async function completeLarkLogin(code: string): Promise<boolean> {
  const verifier = pendingVerifier;
  if (!verifier) return false;
  pendingVerifier = null;
  const res = await api<AgentLarkExchangeResponse>('/v1/auth/lark/exchange', {
    method: 'POST',
    auth: false,
    body: { code, codeVerifier: verifier },
  });
  await saveTokens({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    userId: res.userId,
    workspaceId: res.workspaceId,
  });
  return true;
}

/** Abandon an in-flight Lark login (e.g. the deep-link reported pending/error). */
export function cancelLarkLogin(): void {
  pendingVerifier = null;
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
}

export async function isLoggedIn(): Promise<boolean> {
  const tokens = await loadTokens();
  return tokens !== null;
}
