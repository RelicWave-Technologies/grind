/**
 * Lark Interactive Card (schema 2.0) builders for access requests: a person
 * signed in with Lark for the first time and is waiting for an admin.
 *
 * Pure — no I/O. The pending card carries a form (team + shift dropdowns and
 * Approve) so an admin can activate the person without opening the dashboard;
 * Reject sits outside the form so it never needs a team picked first.
 *
 * Button values carry `{ kind: 'access_request', accessRequestId, action }`;
 * the card callback routes on `kind`.
 */

export const ACCESS_REQUEST_CARD_KIND = 'access_request';
export type AccessCardAction = 'approve' | 'reject';

export interface AccessCardOption {
  id: string;
  name: string;
}

export interface AccessRequestCardInput {
  accessRequestId: string;
  name: string;
  email: string;
  requestedAt: number; // epoch ms
  timeZone: string;
}

export interface PendingAccessCardInput extends AccessRequestCardInput {
  teams: AccessCardOption[];
  shifts: AccessCardOption[];
  /** Pre-selected shift (the one most people are on). */
  defaultShiftId: string | null;
}

export interface DecidedAccessCardInput extends AccessRequestCardInput {
  decision: 'APPROVED' | 'REJECTED';
  via: 'LARK_CARD' | 'DASHBOARD';
  decidedByName: string | null;
  decidedAt: number; // epoch ms
  teamName: string | null;
  shiftName: string | null;
}

function fmtTimestamp(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

/** Lark markdown treats these as syntax; a name is plain text. */
function plain(text: string): string {
  return text.replace(/([*_~`[\]<>])/gu, '\\$1');
}

function whoBlock(req: AccessRequestCardInput): Record<string, unknown> {
  return {
    tag: 'markdown',
    content: `**${plain(req.name)}**\n${plain(req.email)}\nAsked ${fmtTimestamp(req.requestedAt, req.timeZone)}`,
  };
}

function actionValue(req: AccessRequestCardInput, action: AccessCardAction): Record<string, unknown> {
  return { kind: ACCESS_REQUEST_CARD_KIND, accessRequestId: req.accessRequestId, action };
}

function options(items: AccessCardOption[]) {
  return items.map((i) => ({ text: { tag: 'plain_text', content: i.name }, value: i.id }));
}

/** The card every chosen admin gets while the person is waiting. */
export function buildAccessRequestCard(req: PendingAccessCardInput): Record<string, unknown> {
  const shiftSelect: Record<string, unknown> = {
    tag: 'select_static',
    name: 'shiftId',
    placeholder: { tag: 'plain_text', content: 'Shift' },
    width: 'fill',
    options: options(req.shifts),
  };
  if (req.defaultShiftId && req.shifts.some((s) => s.id === req.defaultShiftId)) {
    shiftSelect.initial_option = req.defaultShiftId;
  }
  return {
    schema: '2.0',
    // Lets the callback's replacement card (and later PATCHes) update the
    // message for everyone, not just the person who clicked.
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'New person wants access to Timo' },
      template: 'blue',
    },
    body: {
      elements: [
        whoBlock(req),
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'access_form',
          elements: [
            {
              tag: 'select_static',
              name: 'teamId',
              placeholder: { tag: 'plain_text', content: 'Team' },
              width: 'fill',
              options: options(req.teams),
            },
            shiftSelect,
            {
              tag: 'button',
              name: 'approve',
              text: { tag: 'plain_text', content: 'Approve' },
              type: 'primary_filled',
              form_action_type: 'submit',
              behaviors: [{ type: 'callback', value: actionValue(req, 'approve') }],
            },
          ],
        },
        {
          tag: 'button',
          name: 'reject',
          text: { tag: 'plain_text', content: 'Reject' },
          type: 'danger',
          confirm: {
            title: { tag: 'plain_text', content: 'Reject this person?' },
            text: { tag: 'plain_text', content: `${req.name} will be deactivated. You can reactivate them from People.` },
          },
          behaviors: [{ type: 'callback', value: actionValue(req, 'reject') }],
        },
      ],
    },
  };
}

function decisionLine(req: DecidedAccessCardInput): string {
  const at = fmtTimestamp(req.decidedAt, req.timeZone);
  const by = req.decidedByName ? ` by ${plain(req.decidedByName)}` : '';
  const where = req.via === 'DASHBOARD' ? ' from the dashboard' : '';
  if (req.decision === 'REJECTED') return `**Rejected**${by}${where} · ${at}`;
  const setup = [req.teamName && `Team: ${plain(req.teamName)}`, req.shiftName && `Shift: ${plain(req.shiftName)}`]
    .filter(Boolean)
    .join(' · ');
  return `**Approved**${by}${where} · ${at}${setup ? `\n${setup}` : ''}`;
}

/** Replaces every admin's card once someone decides. */
export function buildDecidedAccessCard(req: DecidedAccessCardInput): Record<string, unknown> {
  const approved = req.decision === 'APPROVED';
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: approved ? 'Access approved' : 'Access rejected' },
      template: approved ? 'green' : 'red',
    },
    body: {
      elements: [whoBlock(req), { tag: 'hr' }, { tag: 'markdown', content: decisionLine(req) }],
    },
  };
}

/** For a click on a card whose request no longer exists (person deleted). */
export function buildUnavailableAccessCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Access request unavailable' },
      template: 'grey',
    },
    body: {
      elements: [{ tag: 'markdown', content: 'This person was removed from Timo. Nothing to do here.' }],
    },
  };
}
