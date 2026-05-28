import os from 'node:os';
import type { LoginResponse, LogoutResponse, UserDto } from '@grind/types';
import { api } from './apiClient';
import { clearTokens, loadTokens, saveTokens } from './tokenStore';

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
