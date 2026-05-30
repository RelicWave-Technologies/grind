/**
 * Lark Interactive Card (v2) JSON builders for manual-time approval.
 *
 * Pure — no I/O, no Lark SDK. Returns the `content` object that gets
 * JSON-stringified into the `content` field of a `msg_type: "interactive"`
 * message (or fed back to `card.action.trigger` to update the card in place).
 *
 * Button `value` payloads carry `{ requestId, action }` so the callback
 * handler can route the decision without needing to look up message ids.
 */

export type ApprovalAction = 'approve' | 'reject';

export interface ApprovalCardInput {
  requestId: string;
  requesterName: string;
  /** Lark task summary if the request is attributed to one. */
  taskSummary?: string | null;
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms
  reason: string;
}

export interface DecidedCardInput extends ApprovalCardInput {
  decision: 'APPROVED' | 'REJECTED';
  decidedByName: string;
  decidedAt: number; // epoch ms
}

function fmtRange(startMs: number, endMs: number): string {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const sameDay = start.toDateString() === end.toDateString();
  const dOpts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const tOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (sameDay) return `${start.toLocaleDateString(undefined, dOpts)} · ${start.toLocaleTimeString(undefined, tOpts)} – ${end.toLocaleTimeString(undefined, tOpts)}`;
  return `${start.toLocaleString(undefined, { ...dOpts, ...tOpts })} → ${end.toLocaleString(undefined, { ...dOpts, ...tOpts })}`;
}

function fmtDurationMinutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function detailFields(req: ApprovalCardInput) {
  const fields: Array<{ is_short: boolean; text: { tag: 'lark_md'; content: string } }> = [
    { is_short: true, text: { tag: 'lark_md', content: `**Who**\n${req.requesterName}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**Duration**\n${fmtDurationMinutes(req.endedAt - req.startedAt)}` } },
    { is_short: false, text: { tag: 'lark_md', content: `**When**\n${fmtRange(req.startedAt, req.endedAt)}` } },
  ];
  if (req.taskSummary) fields.push({ is_short: false, text: { tag: 'lark_md', content: `**Task**\n${req.taskSummary}` } });
  fields.push({ is_short: false, text: { tag: 'lark_md', content: `**Reason**\n${req.reason}` } });
  return fields;
}

/** The pending approval card sent to the approver. */
export function buildApprovalCard(req: ApprovalCardInput): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Manual time request' },
      template: 'blue',
    },
    elements: [
      { tag: 'div', fields: detailFields(req) },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Approve' },
            type: 'primary',
            value: { requestId: req.requestId, action: 'approve' as ApprovalAction },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Reject' },
            type: 'danger',
            value: { requestId: req.requestId, action: 'reject' as ApprovalAction },
          },
        ],
      },
    ],
  };
}

/** The post-decision card returned to Lark to replace the pending one in place. */
export function buildDecidedCard(req: DecidedCardInput): Record<string, unknown> {
  const approved = req.decision === 'APPROVED';
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: approved ? 'Time approved' : 'Time rejected' },
      template: approved ? 'green' : 'red',
    },
    elements: [
      { tag: 'div', fields: detailFields(req) },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${approved ? 'Approved' : 'Rejected'}** by ${req.decidedByName} · ${new Date(req.decidedAt).toLocaleString()}`,
        },
      },
    ],
  };
}
