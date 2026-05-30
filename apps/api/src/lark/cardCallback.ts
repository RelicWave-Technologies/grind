import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { isLarkConfigured, getLarkConfig } from './config';
import { decideRequest } from './decide';
import { logger } from '../logger';

/**
 * Subscribes to Lark `card.action.trigger` events over a long-connection
 * WebSocket — no public URL needed (matches the M7 Build-Plan §3.1 decision).
 *
 * Each click must be acknowledged within 3 seconds with the updated card,
 * which Lark uses to replace the original message in place. We dispatch the
 * decision synchronously inside that window because `decideRequest` is a fast
 * DB transaction; if it ever grew, we'd respond first and update async.
 */

let wsClient: WSClient | null = null;

type CardActionEvent = {
  action?: { value?: unknown };
  operator?: { open_id?: string };
};

function parseValue(raw: unknown): { requestId?: string; action?: 'approve' | 'reject' } {
  // value is the object we put in the button at build time.
  if (raw && typeof raw === 'object') {
    const v = raw as Record<string, unknown>;
    return {
      requestId: typeof v.requestId === 'string' ? v.requestId : undefined,
      action: v.action === 'approve' || v.action === 'reject' ? v.action : undefined,
    };
  }
  return {};
}

export function startCardCallback(): void {
  if (!isLarkConfigured()) {
    logger.info('lark card callback subscriber not started — Lark not configured');
    return;
  }
  if (wsClient) return;
  const { appId, appSecret, oauthHost } = getLarkConfig();
  const domain = oauthHost.includes('larksuite') ? 'https://open.larksuite.com' : 'https://open.feishu.cn';

  wsClient = new WSClient({ appId, appSecret, domain });

  const dispatcher = new EventDispatcher({}).register({
    'card.action.trigger': async (raw: CardActionEvent) => {
      try {
        const { requestId, action } = parseValue(raw.action?.value);
        const decidedByOpenId = raw.operator?.open_id;
        if (!requestId || !action || !decidedByOpenId) {
          logger.warn({ raw }, 'card.action.trigger: missing requestId/action/operator');
          return { toast: { type: 'error', content: 'Bad payload' } };
        }
        const result = await decideRequest({ requestId, action, decidedByOpenId });
        if (!result) {
          return { toast: { type: 'error', content: 'Request not found' } };
        }
        if (result.noop === 'forbidden') {
          return { toast: { type: 'error', content: 'Only the assigned approver can decide this request.' } };
        }
        return {
          toast: { type: 'success', content: `Marked ${result.status.toLowerCase()}` },
          card: { type: 'raw', data: result.card },
        };
      } catch (err) {
        logger.error({ err: String(err) }, 'card.action.trigger handler failed');
        return { toast: { type: 'error', content: 'Server error' } };
      }
    },
  });

  // start() returns a promise but runs the long-connection in the background.
  wsClient
    .start({ eventDispatcher: dispatcher })
    .then(() => logger.info('lark card callback subscriber started'))
    .catch((err) => logger.error({ err: String(err) }, 'lark card callback subscriber failed to start'));
}
