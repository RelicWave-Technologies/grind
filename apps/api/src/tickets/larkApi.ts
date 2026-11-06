import { getLarkConfig, isLarkConfigured } from '../lark/config';
import { getTenantAccessToken } from '../lark/tenantToken';
import { outboundTimeoutSignal } from '../lib/outboundTimeout';

/**
 * The few Lark calls tickets need beyond sending and updating messages:
 * pinning a card in an admin's chat with the bot, and downloading an image or
 * file someone sent the bot. Bot identity (tenant token) throughout.
 */

async function larkFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { oauthHost } = getLarkConfig();
  const token = await getTenantAccessToken();
  return fetch(`${oauthHost}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: outboundTimeoutSignal(),
  });
}

/** Pin a message in its chat. Needs the `im:message.pins:write_only` scope. */
export async function pinLarkMessage(messageId: string): Promise<void> {
  const res = await larkFetch('/open-apis/im/v1/pins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ message_id: messageId }),
  });
  const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
  if (body.code !== 0) throw new Error(`lark pin: ${body.msg ?? body.code}`);
}

export async function unpinLarkMessage(messageId: string): Promise<void> {
  const res = await larkFetch(`/open-apis/im/v1/pins/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
  const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
  if (body.code !== 0) throw new Error(`lark unpin: ${body.msg ?? body.code}`);
}

/**
 * Download an image or file a person sent the bot, by the message and the key
 * in its content. Refuses anything bigger than `maxBytes` before reading it all.
 */
export async function downloadLarkMessageResource(args: {
  messageId: string;
  fileKey: string;
  type: 'image' | 'file';
  maxBytes: number;
}): Promise<{ data: Buffer; mimeType: string }> {
  const res = await larkFetch(
    `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/resources/${encodeURIComponent(args.fileKey)}?type=${args.type}`,
  );
  const mimeType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
  if (!res.ok || mimeType === 'application/json') {
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    throw new Error(`lark resource: ${body.msg ?? body.code ?? res.status}`);
  }
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > args.maxBytes) throw new Error('lark resource: too_large');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength > args.maxBytes) throw new Error('lark resource: too_large');
  return { data, mimeType };
}

/** Lark refuses a send to someone outside the bot's availability, or with a bad id. Retrying will not help. */
export function isLarkUnreachable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /NO availability|invalid receive_id|user not found|not in the chat|bot can not chat with/iu.test(msg);
}

export function larkReady(): boolean {
  return isLarkConfigured();
}
