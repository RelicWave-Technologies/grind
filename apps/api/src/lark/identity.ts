import type { PrismaClient } from '@grind/db';
import { getLarkConfig } from './config';

/**
 * Resolves Grind users to their Lark identity (email -> open_id), using a
 * tenant access token. Defined as an interface so route/identity logic can be
 * tested against a fake without hitting Lark.
 */
export interface ResolvedLarkUser {
  openId: string;
  unionId?: string | null;
  userIdLark?: string | null;
}

export interface TenantClient {
  /** Resolve one email to a Lark identity, or null if not in the tenant. */
  resolveByEmail(email: string): Promise<ResolvedLarkUser | null>;
  /** Resolve display names for a set of open_ids. Missing ids are simply absent. */
  namesByOpenId(openIds: string[]): Promise<Map<string, string>>;
}

/**
 * Upsert the LarkIdentity row for a user. Returns the resolved identity, or
 * null if the email isn't a member of the Lark tenant (caller decides how to
 * surface that — usually "ask an admin to invite this email to Lark").
 */
export async function resolveIdentity(
  prisma: PrismaClient,
  userId: string,
  email: string,
  client: TenantClient,
): Promise<ResolvedLarkUser | null> {
  const resolved = await client.resolveByEmail(email);
  if (!resolved) return null;
  const data = {
    openId: resolved.openId,
    unionId: resolved.unionId ?? null,
    userIdLark: resolved.userIdLark ?? null,
  };
  await prisma.larkIdentity.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  return resolved;
}

type TenantTokenBody = { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
type BatchGetIdBody = {
  code?: number;
  msg?: string;
  data?: { user_list?: Array<{ user_id?: string; email?: string }> };
};

/**
 * Real tenant client: caches the tenant_access_token (~2h TTL) and calls
 * contact/v3/users/batch_get_id to map an email to an open_id.
 */
export class HttpTenantClient implements TenantClient {
  private cached: { token: string; expiresAtMs: number } | null = null;

  private async tenantToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAtMs - 60_000 > now) return this.cached.token;
    const { oauthHost, appId, appSecret } = getLarkConfig();
    const res = await fetch(`${oauthHost}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const body = (await res.json().catch(() => ({}))) as TenantTokenBody;
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`tenant token error: ${body.msg ?? body.code}`);
    }
    this.cached = {
      token: body.tenant_access_token,
      expiresAtMs: now + (body.expire ?? 7200) * 1000,
    };
    return this.cached.token;
  }

  async namesByOpenId(openIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    // Only real users have open_ids (ou_…). Tasks created by a bot/app have a
    // cli_… creator id, which the contact API rejects — and which has no name.
    const unique = [...new Set(openIds.filter((id) => id && id.startsWith('ou_')))];
    if (unique.length === 0) return out;
    const { oauthHost } = getLarkConfig();
    const token = await this.tenantToken();
    // contact/v3/users/batch supports up to 50 ids per call.
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const url = new URL('/open-apis/contact/v3/users/batch', oauthHost);
      url.searchParams.set('user_id_type', 'open_id');
      for (const id of chunk) url.searchParams.append('user_ids', id);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const body = (await res.json().catch(() => ({}))) as {
        code?: number;
        data?: { items?: Array<{ open_id?: string; name?: string }> };
      };
      if (body.code !== 0) continue; // name resolution is best-effort
      for (const u of body.data?.items ?? []) {
        if (u.open_id && u.name) out.set(u.open_id, u.name);
      }
    }
    return out;
  }

  async resolveByEmail(email: string): Promise<ResolvedLarkUser | null> {
    const { oauthHost } = getLarkConfig();
    const token = await this.tenantToken();
    const url = new URL('/open-apis/contact/v3/users/batch_get_id', oauthHost);
    url.searchParams.set('user_id_type', 'open_id');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ emails: [email] }),
    });
    const body = (await res.json().catch(() => ({}))) as BatchGetIdBody;
    if (body.code !== 0) throw new Error(`batch_get_id error: ${body.msg ?? body.code}`);
    const match = body.data?.user_list?.find((u) => u.email === email && u.user_id);
    if (!match?.user_id) return null;
    return { openId: match.user_id };
  }
}
