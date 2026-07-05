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

export interface LarkChatMessage {
  messageId: string;
  chatId: string | null;
  senderOpenId: string | null;
  messageType: string | null;
  content: string;
  createTimeMs: number;
}

export interface ListChatMessagesResult {
  messages: LarkChatMessage[];
  pageToken: string | null;
  hasMore: boolean;
}

export interface LarkMessenger {
  /** Send an interactive card to a Lark user by their open_id. */
  sendCard(receiveOpenId: string, card: Record<string, unknown>): Promise<SendCardResult>;
  /** Send an interactive card to a Lark group by chat_id. */
  sendCardToChat(chatId: string, card: Record<string, unknown>, uuid?: string): Promise<SendCardResult>;
  /** Replace an already-sent card in place (used by the decision flow). */
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  /**
   * Send a small plain-text IM ("Request updated", "Request cancelled"). Used
   * by edits and cancellation as a low-noise nudge above the original card.
   * Best-effort: callers should never fail on this throwing.
   */
  sendText(receiveOpenId: string, text: string): Promise<SendCardResult>;
  /** Send plain text to a Lark group by chat_id. */
  sendTextToChat(chatId: string, text: string, uuid?: string): Promise<SendCardResult>;
  /** Poll bounded group chat history for passive issue detection. */
  listChatMessages?(args: {
    chatId: string;
    start?: Date;
    end?: Date;
    pageToken?: string | null;
    pageSize?: number;
  }): Promise<ListChatMessagesResult>;
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
    return this.sendMessage('open_id', receiveOpenId, 'interactive', JSON.stringify(card));
  }

  async sendCardToChat(chatId: string, card: Record<string, unknown>, uuid?: string): Promise<SendCardResult> {
    return this.sendMessage('chat_id', chatId, 'interactive', JSON.stringify(card), uuid);
  }

  async sendText(receiveOpenId: string, text: string): Promise<SendCardResult> {
    return this.sendMessage('open_id', receiveOpenId, 'text', JSON.stringify({ text }));
  }

  async sendTextToChat(chatId: string, text: string, uuid?: string): Promise<SendCardResult> {
    return this.sendMessage('chat_id', chatId, 'text', JSON.stringify({ text }), uuid);
  }

  private async sendMessage(
    receiveIdType: 'open_id' | 'chat_id',
    receiveId: string,
    msgType: 'text' | 'interactive',
    content: string,
    uuid?: string,
  ): Promise<SendCardResult> {
    const { oauthHost } = getLarkConfig();
    const token = await this.getTenantToken();
    const url = new URL('/open-apis/im/v1/messages', oauthHost);
    url.searchParams.set('receive_id_type', receiveIdType);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content, ...(uuid ? { uuid } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as SendBody;
    if (body.code !== 0 || !body.data?.message_id) {
      throw new Error(`lark sendMessage: ${body.msg ?? body.code}`);
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

  async listChatMessages(args: {
    chatId: string;
    start?: Date;
    end?: Date;
    pageToken?: string | null;
    pageSize?: number;
  }): Promise<ListChatMessagesResult> {
    const { oauthHost } = getLarkConfig();
    const token = await this.getTenantToken();
    const url = new URL('/open-apis/im/v1/messages', oauthHost);
    url.searchParams.set('container_id_type', 'chat');
    url.searchParams.set('container_id', args.chatId);
    url.searchParams.set('sort_type', 'ByCreateTimeAsc');
    url.searchParams.set('page_size', String(Math.min(Math.max(args.pageSize ?? 50, 1), 50)));
    url.searchParams.set('only_thread_root_messages', 'true');
    if (args.start) url.searchParams.set('start_time', String(Math.floor(args.start.getTime() / 1000)));
    if (args.end) url.searchParams.set('end_time', String(Math.floor(args.end.getTime() / 1000)));
    if (args.pageToken) url.searchParams.set('page_token', args.pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json().catch(() => ({}))) as {
      code?: number;
      msg?: string;
      data?: { has_more?: boolean; page_token?: string; items?: unknown[] };
    };
    if (body.code !== 0) throw new Error(`lark listChatMessages: ${body.msg ?? body.code}`);
    return {
      messages: (body.data?.items ?? []).map(parseChatMessage).filter((m): m is LarkChatMessage => Boolean(m)),
      hasMore: Boolean(body.data?.has_more),
      pageToken: body.data?.page_token ?? null,
    };
  }
}

function parseChatMessage(raw: unknown): LarkChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const sender = m.sender && typeof m.sender === 'object' ? (m.sender as Record<string, unknown>) : null;
  const senderId = sender?.id && typeof sender.id === 'object' ? (sender.id as Record<string, unknown>) : null;
  const body = m.body && typeof m.body === 'object' ? (m.body as Record<string, unknown>) : null;
  const messageId = typeof m.message_id === 'string' ? m.message_id : null;
  if (!messageId) return null;
  const createTime = typeof m.create_time === 'string' ? Number(m.create_time) : Date.now();
  const senderOpenId =
    typeof senderId?.open_id === 'string'
      ? senderId.open_id
      : sender?.id_type === 'open_id' && typeof sender.id === 'string'
        ? sender.id
        : null;
  return {
    messageId,
    chatId: typeof m.chat_id === 'string' ? m.chat_id : null,
    senderOpenId,
    messageType: typeof m.msg_type === 'string' ? m.msg_type : null,
    content: renderMessageContent(typeof body?.content === 'string' ? body.content : '', m.mentions),
    createTimeMs: Number.isFinite(createTime) ? createTime : Date.now(),
  };
}

function renderMessageContent(content: string, mentions: unknown): string {
  if (!content) return '';
  let text = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
      text = (parsed as { text: string }).text;
    }
  } catch {
    // Keep opaque non-text payloads inspectable in audit rows.
  }
  if (!Array.isArray(mentions)) return text;
  return mentions.reduce((next, mention) => {
    if (!mention || typeof mention !== 'object') return next;
    const item = mention as { key?: unknown; name?: unknown };
    if (typeof item.key !== 'string' || typeof item.name !== 'string') return next;
    return next.split(item.key).join(`@${item.name}`);
  }, text);
}
