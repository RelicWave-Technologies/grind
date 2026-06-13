import { getLarkConfig } from './config';

/**
 * The identity Grind reads from Lark at login. Sourced from a single call to
 * `GET /open-apis/authen/v1/user_info` with the user_access_token — which
 * returns open_id/union_id/name/avatar plus email/enterprise_email (the latter
 * requires the `contact:user.email:readonly` scope). `open_id` is the stable,
 * app-scoped key Grind stores; email is normalized for matching.
 */
export interface LarkProfile {
  openId: string;
  unionId: string | null;
  name: string;
  /** enterprise_email ?? email, trimmed + lowercased; null if Lark returned none. */
  email: string | null;
  avatarUrl: string | null;
}

export interface ProfileClient {
  getProfile(accessToken: string): Promise<LarkProfile | null>;
}

type RawUserInfo = {
  code?: number;
  data?: {
    open_id?: string;
    union_id?: string;
    name?: string;
    avatar_url?: string;
    email?: string;
    enterprise_email?: string;
  };
};

export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v.length > 0 ? v : null;
}

export class HttpProfileClient implements ProfileClient {
  async getProfile(accessToken: string): Promise<LarkProfile | null> {
    const { oauthHost } = getLarkConfig();
    let body: RawUserInfo;
    try {
      const res = await fetch(`${oauthHost}/open-apis/authen/v1/user_info`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      body = (await res.json().catch(() => ({}))) as RawUserInfo;
    } catch {
      return null; // network failure → treated as "could not resolve" by caller
    }
    const d = body.data;
    if (body.code !== 0 || !d?.open_id) return null;
    return {
      openId: d.open_id,
      unionId: d.union_id ?? null,
      name: (d.name ?? '').trim(),
      // Prefer the work email; fall back to personal. Either may be absent
      // unless the email scope was granted.
      email: normalizeEmail(d.enterprise_email) ?? normalizeEmail(d.email),
      avatarUrl: d.avatar_url ?? null,
    };
  }
}
