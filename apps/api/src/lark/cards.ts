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

export interface UnavailableRequestCardInput {
  requestId: string;
}

export interface PayrollReminderItem {
  requestId: string;
  requesterName: string;
  taskSummary?: string | null;
  startedAt: number;
  endedAt: number;
  reason: string;
  ageMs?: number;
}

export interface PayrollReminderCardInput {
  month: string;
  audience: 'requester' | 'approver';
  teamName?: string | null;
  recipientName?: string | null;
  requests: PayrollReminderItem[];
  dashboardUrl?: string;
  generatedAt?: number;
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

function fmtAge(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const hours = Math.max(0, Math.round(ms / (60 * 60 * 1000)));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

function fmtClockRange(startMs: number, endMs: number): string {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const dOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const tOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (start.toDateString() === end.toDateString()) {
    return `${start.toLocaleDateString(undefined, dOpts)} · ${start.toLocaleTimeString(undefined, tOpts)} – ${end.toLocaleTimeString(undefined, tOpts)}`;
  }
  return `${start.toLocaleString(undefined, { ...dOpts, ...tOpts })} → ${end.toLocaleString(undefined, { ...dOpts, ...tOpts })}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}

function detailFields(req: ApprovalCardInput) {
  const fields: Array<{ is_short: boolean; text: { tag: 'lark_md'; content: string } }> = [
    { is_short: true, text: { tag: 'lark_md', content: `**Who**\n${req.requesterName}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**Duration**\n${fmtDurationMinutes(req.endedAt - req.startedAt)}` } },
    { is_short: false, text: { tag: 'lark_md', content: `**When**\n${fmtRange(req.startedAt, req.endedAt)}` } },
  ];
  fields.push({
    is_short: false,
    text: { tag: 'lark_md', content: `**Task**\n${req.taskSummary?.trim() ? req.taskSummary : '_Untracked_'}` },
  });
  fields.push({ is_short: false, text: { tag: 'lark_md', content: `**Reason**\n${req.reason}` } });
  return fields;
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
          content: `**This request was updated** at ${new Date(req.supersededAt).toLocaleString()}. See the new card below — these buttons no longer apply.`,
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
          content: `**Withdrawn by ${req.requesterName}** · ${new Date(req.cancelledAt).toLocaleString()}. You can ignore this card.`,
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

/** Payroll month-close reminder card for pending manual-time approvals. */
export function buildPayrollReminderCard(input: PayrollReminderCardInput): Record<string, unknown> {
  const shown = input.requests.slice(0, 8);
  const hidden = Math.max(0, input.requests.length - shown.length);
  const totalMs = input.requests.reduce((sum, req) => sum + Math.max(0, req.endedAt - req.startedAt), 0);
  const oldestAgeMs = input.requests.reduce((max, req) => Math.max(max, req.ageMs ?? 0), 0);
  const isApprover = input.audience === 'approver';
  const subtitle = isApprover
    ? `Review before payroll close${input.teamName ? ` · ${input.teamName}` : ''}`
    : 'Your payroll may be affected until these are decided';
  const itemLines = shown.length
    ? shown.map((req, index) => {
      const task = req.taskSummary?.trim() || 'Manual time';
      const age = req.ageMs !== undefined ? ` · waiting ${fmtAge(req.ageMs)}` : '';
      return [
        `**${index + 1}. ${req.requesterName}** · ${fmtDurationMinutes(req.endedAt - req.startedAt)}${age}`,
        `${fmtClockRange(req.startedAt, req.endedAt)} · ${task}`,
        `_${truncate(req.reason, 110)}_`,
      ].join('\n');
    }).join('\n\n')
    : '_No pending approvals._';

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${subtitle}**`,
      },
    },
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Pending**\n${input.requests.length}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Total time**\n${fmtDurationMinutes(totalMs)}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**Oldest**\n${oldestAgeMs ? fmtAge(oldestAgeMs) : 'New'}` } },
        {
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**Scope**\n${isApprover ? (input.teamName ?? 'Assigned queue') : 'Your requests'}`,
          },
        },
      ],
    },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'lark_md', content: itemLines } },
  ];

  if (hidden > 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**+${hidden} more pending approval${hidden === 1 ? '' : 's'}** · open Grind to review the full list.`,
      },
    });
  }
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: input.generatedAt ? `_Generated ${new Date(input.generatedAt).toLocaleString()}_` : '_Generated by Grind payroll month close_',
    },
  });
  if (input.dashboardUrl) {
    elements.push(
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: isApprover ? 'Open approvals' : 'Open my approvals' },
            type: 'primary',
            url: input.dashboardUrl,
          },
        ],
      },
    );
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `Payroll approvals · ${input.month}` },
      subtitle: { tag: 'plain_text', content: input.recipientName ? `For ${input.recipientName}` : 'Month close reminder' },
      template: input.requests.length > 0 ? 'orange' : 'green',
    },
    elements,
  };
}
