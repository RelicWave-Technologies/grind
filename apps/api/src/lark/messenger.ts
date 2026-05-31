import { getLarkConfig } from './config';

/**
 * Sends Lark IM messages on the bot's behalf. Injected into routes so the
 * manual-time-approval logic is testable end-to-end against a Fake without
 * hitting Lark, while production uses the real HTTP implementation.
 *
 * Auth model: tenant_access_token (bot identity). Requires the
 * `im:message:send_as_bot` scope.
 */
export interface SendCardResult {
  messageId: string;
}

export interface LarkMessenger {
  /** Send an interactive card to a Lark user by their open_id. */
  sendCard(receiveOpenId: string, card: Record<string, unknown>): Promise<SendCardResult>;
  /** Replace an already-sent card in place (used by the decision flow). */
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
}

type SendBody = { code?: number; msg?: string; data?: { message_id?: string } };

/** Real HTTP implementation backed by a tenant_access_token with a small cache. */
export class HttpLarkMessenger implements LarkMessenger {
  private tenantToken: { token: string; expiresAtMs: number } | null = null;

  private async getTenantToken(): Promise<string> {
    const now = Date.now();
    if (this.tenantToken && this.tenantToken.expiresAtMs - 60_000 > now) return this.tenantToken.token;
    const { oauthHost, appId, appSecret } = getLarkConfig();
    const res = await fetch(`${oauthHost}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (body.code !== 0 || !body.tenant_access_token) throw new Error(`tenant token: ${body.msg ?? body.code}`);
    this.tenantToken = { token: body.tenant_access_token, expiresAtMs: now + (body.expire ?? 7200) * 1000 };
    return this.tenantToken.token;
  }

  async sendCard(receiveOpenId: string, card: Record<string, unknown>): Promise<SendCardResult> {
    const { oauthHost } = getLarkConfig();
    const token = await this.getTenantToken();
    const url = new URL('/open-apis/im/v1/messages', oauthHost);
    url.searchParams.set('receive_id_type', 'open_id');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: receiveOpenId, msg_type: 'interactive', content: JSON.stringify(card) }),
    });
    const body = (await res.json().catch(() => ({}))) as SendBody;
    if (body.code !== 0 || !body.data?.message_id) {
      throw new Error(`lark sendCard: ${body.msg ?? body.code}`);
    }
    return { messageId: body.data.message_id };
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    const { oauthHost } = getLarkConfig();
    const token = await this.getTenantToken();
    const res = await fetch(`${oauthHost}/open-apis/im/v1/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: JSON.stringify(card) }),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (body.code !== 0) throw new Error(`lark updateCard: ${body.msg ?? body.code}`);
  }
}
