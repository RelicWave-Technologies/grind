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
  /** Durable Lark-message ledger id. Required for new actionable cards. */
  cardId?: string;
  /** ManualTimeRequest.version represented by this card. */
  version?: number;
  requesterName: string;
  /** Lark task summary if the request is attributed to one. */
  taskSummary?: string | null;
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms
  reason: string;
  /** Workspace business timezone for every calendar value in this card. */
  timeZone: string;
}

export interface DecidedCardInput extends ApprovalCardInput {
  decision: 'APPROVED' | 'REJECTED';
  decidedByName: string;
  decidedAt: number; // epoch ms
}

export interface UnavailableRequestCardInput {
  requestId: string;
}

export interface StaleRequestCardInput {
  requestId: string;
  version?: number | null;
  currentVersion?: number | null;
}

function formatAt(ms: number, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(new Date(ms));
}

function fmtRange(startMs: number, endMs: number, timeZone: string): string {
  const sameDay = formatAt(startMs, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' })
    === formatAt(endMs, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const dOpts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const tOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (sameDay) return `${formatAt(startMs, timeZone, dOpts)} · ${formatAt(startMs, timeZone, tOpts)} – ${formatAt(endMs, timeZone, tOpts)}`;
  return `${formatAt(startMs, timeZone, { ...dOpts, ...tOpts })} → ${formatAt(endMs, timeZone, { ...dOpts, ...tOpts })}`;
}

function fmtDurationMinutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function fmtTimestamp(ms: number, timeZone: string): string {
  return formatAt(ms, timeZone, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function detailFields(req: ApprovalCardInput) {
  const fields: Array<{ is_short: boolean; text: { tag: 'lark_md'; content: string } }> = [
    { is_short: true, text: { tag: 'lark_md', content: `**Who**\n${req.requesterName}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**Duration**\n${fmtDurationMinutes(req.endedAt - req.startedAt)}` } },
    { is_short: false, text: { tag: 'lark_md', content: `**When**\n${fmtRange(req.startedAt, req.endedAt, req.timeZone)}` } },
  ];
  fields.push({
    is_short: false,
    text: { tag: 'lark_md', content: `**Task**\n${req.taskSummary?.trim() ? req.taskSummary : '_Untracked_'}` },
  });
  fields.push({ is_short: false, text: { tag: 'lark_md', content: `**Reason**\n${req.reason}` } });
  return fields;
}

function actionValue(req: ApprovalCardInput, action: ApprovalAction): Record<string, unknown> {
  return {
    requestId: req.requestId,
    cardId: req.cardId,
    version: req.version,
    action,
  };
}

/** The pending approval card sent to the approver. */
export function buildApprovalCard(req: ApprovalCardInput): Record<string, unknown> {
  return {
    // `update_multi: true` is required on the ORIGINAL card so that the
    // card.action.trigger callback's replacement card can update the message
    // for everyone (not just the clicker). Without it Lark rejects the update
    // with code 200340 ("card action handle failed").
    config: { wide_screen_mode: true, update_multi: true },
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
            value: actionValue(req, 'approve'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Reject' },
            type: 'danger',
            value: actionValue(req, 'reject'),
          },
        ],
      },
    ],
  };
}

/**
 * Used when the requester EDITS a pending request. The previous card is
 * rewritten with this "superseded" variant: grey header, no Approve/Reject
 * buttons, and a clear note pointing the approver at the new card. Prevents
 * an in-flight approver from clicking stale buttons.
 */
export interface SupersededCardInput extends ApprovalCardInput {
  /** When the supersession happened (epoch ms). */
  supersededAt: number;
}
export function buildSupersededCard(req: SupersededCardInput): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Manual time request — updated' },
      template: 'grey',
    },
    elements: [
      { tag: 'div', fields: detailFields(req) },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**This request was updated** at ${fmtTimestamp(req.supersededAt, req.timeZone)}. See the new card below — these buttons no longer apply.`,
        },
      },
    ],
  };
}

/** A single "old → new" entry in the diff section on an updated card. */
export interface DiffEntry {
  label: string;
  before: string;
  after: string;
}

export interface UpdatedApprovalCardInput extends ApprovalCardInput {
  diff: DiffEntry[];
}

/**
 * Sent as a NEW message after the requester edits a pending request. Looks
 * like a normal approval card (Approve/Reject buttons carrying the same
 * requestId) but includes a "What changed" section so the approver sees the
 * delta at a glance.
 */
export function buildUpdatedApprovalCard(req: UpdatedApprovalCardInput): Record<string, unknown> {
  const diffContent = req.diff.length === 0
    ? '_no field changes_'
    : req.diff.map((d) => `**${d.label}:** ~~${d.before || '—'}~~ → **${d.after || '—'}**`).join('\n');
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Manual time request — updated' },
      template: 'orange',
    },
    elements: [
      { tag: 'div', fields: detailFields(req) },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**What changed**\n${diffContent}` } },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Approve' },
            type: 'primary',
            value: actionValue(req, 'approve'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Reject' },
            type: 'danger',
            value: actionValue(req, 'reject'),
          },
        ],
      },
    ],
  };
}

/**
 * Used when the requester WITHDRAWS a pending request. The card is rewritten
 * in place: red header, no Approve/Reject buttons, and a "withdrawn by
 * requester" note. After this, the approver can't act on stale buttons.
 */
export interface CancelledCardInput extends ApprovalCardInput {
  /** When the withdrawal happened (epoch ms). */
  cancelledAt: number;
}
export function buildCancelledCard(req: CancelledCardInput): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Manual time request — withdrawn' },
      template: 'red',
    },
    elements: [
      { tag: 'div', fields: detailFields(req) },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**Withdrawn by ${req.requesterName}** · ${fmtTimestamp(req.cancelledAt, req.timeZone)}. You can ignore this card.`,
        },
      },
    ],
  };
}

/** Used when someone clicks a stale Lark card whose backing DB row is gone. */
export function buildUnavailableRequestCard(req: UnavailableRequestCardInput): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Manual time request unavailable' },
      template: 'grey',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            'This card is stale or the request was removed. Open Timo and use the latest approval request.',
        },
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `Request ${req.requestId}` }],
      },
    ],
  };
}

/** Used when an old card is clicked after the request was edited/decided. */
export function buildStaleRequestCard(req: StaleRequestCardInput): Record<string, unknown> {
  const note =
    req.currentVersion && req.version
      ? `This card is version ${req.version}; the latest request is version ${req.currentVersion}.`
      : 'This card is not the latest approval card.';
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Manual time request — stale' },
      template: 'grey',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${note} Open Timo or use the latest Lark card before approving.`,
        },
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `Request ${req.requestId}` }],
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
          content: `**${approved ? 'Approved' : 'Rejected'}** by ${req.decidedByName} · ${fmtTimestamp(req.decidedAt, req.timeZone)}`,
        },
      },
    ],
  };
}

