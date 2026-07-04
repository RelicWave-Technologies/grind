import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { isLarkConfigured, getLarkConfig } from './config';
import { decideRequest } from './decide';
import { buildUnavailableRequestCard } from './cards';
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

function parseValue(raw: unknown): { requestId?: string; cardId?: string; version?: number; action?: 'approve' | 'reject' } {
  // value is the object we put in the button at build time.
  if (typeof raw === 'string') {
    try {
      return parseValue(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object') {
    const v = raw as Record<string, unknown>;
    return {
      requestId: typeof v.requestId === 'string' ? v.requestId : undefined,
      cardId: typeof v.cardId === 'string' ? v.cardId : undefined,
      version: typeof v.version === 'number' ? v.version : undefined,
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
        const { requestId, cardId, version, action } = parseValue(raw.action?.value);
        const decidedByOpenId = raw.operator?.open_id;
        if (!requestId || !action || !decidedByOpenId) {
          logger.warn(
            { hasValue: raw.action?.value !== undefined, hasOperator: Boolean(decidedByOpenId) },
            'card.action.trigger: missing requestId/action/operator',
          );
          return { toast: { type: 'error', content: 'Bad payload' } };
        }
        if (!cardId || version === undefined) {
          logger.warn({ requestId, action, decidedByOpenId, hasCardId: Boolean(cardId), hasVersion: version !== undefined }, 'card.action.trigger: stale legacy payload');
          return {
            toast: { type: 'error', content: 'This approval card is old. Use the latest Timo card.' },
            card: { type: 'raw', data: buildUnavailableRequestCard({ requestId }) },
          };
        }
        logger.info({ requestId, cardId, version, action, decidedByOpenId }, 'card.action.trigger: decision received');
        const result = await decideRequest({ requestId, action, decidedByOpenId, cardId, version });
        if (!result) {
          logger.warn({ requestId, action, decidedByOpenId }, 'card.action.trigger: request not found');
          return {
            toast: { type: 'error', content: 'This approval card is stale. Open the latest request in Timo.' },
            card: { type: 'raw', data: buildUnavailableRequestCard({ requestId }) },
          };
        }
        if (result.noop === 'forbidden') {
          logger.warn({ requestId, action, decidedByOpenId }, 'card.action.trigger: forbidden decider');
          return { toast: { type: 'error', content: 'Only the assigned approver can decide this request.' } };
        }
        if (result.noop === 'self_approval_forbidden') {
          logger.warn({ requestId, action, decidedByOpenId }, 'card.action.trigger: self approval forbidden');
          return { toast: { type: 'error', content: 'Another approver must decide this request.' } };
        }
        if (result.noop === 'stale_card') {
          logger.warn({ requestId, cardId, version, action, decidedByOpenId }, 'card.action.trigger: stale card');
          return {
            toast: { type: 'error', content: 'This approval card is stale. Use the latest request.' },
            card: { type: 'raw', data: result.card },
          };
        }
        logger.info({ requestId, action, status: result.status, noop: result.noop }, 'card.action.trigger: decision handled');
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
