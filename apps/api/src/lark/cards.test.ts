import { describe, it, expect } from 'vitest';
import { buildApprovalCard, buildDecidedCard, type ApprovalCardInput } from './cards';

const REQ: ApprovalCardInput = {
  requestId: 'req_abc',
  requesterName: 'Anish Suman',
  taskSummary: 'Implement onboarding',
  startedAt: new Date('2026-05-29T09:00:00Z').getTime(),
  endedAt: new Date('2026-05-29T10:30:00Z').getTime(),
  reason: 'Forgot to start the tracker',
};

/** Walk every element looking for action buttons, returning their `value` payloads. */
type Card = Record<string, unknown>;
function buttonValues(card: Card): Array<{ requestId?: string; action?: string }> {
  const out: Array<{ requestId?: string; action?: string }> = [];
  const els = (card.elements as Array<Record<string, unknown>> | undefined) ?? [];
  for (const el of els) {
    if (el.tag !== 'action') continue;
    const actions = (el.actions as Array<Record<string, unknown>> | undefined) ?? [];
    for (const a of actions) {
      if (a.tag === 'button' && typeof a.value === 'object' && a.value)
        out.push(a.value as { requestId?: string; action?: string });
    }
  }
  return out;
}

function findTextContaining(card: Card, needle: string): boolean {
  const seen: unknown[] = [card];
  while (seen.length) {
    const x = seen.pop();
    if (typeof x === 'string' && x.includes(needle)) return true;
    if (x && typeof x === 'object') for (const v of Object.values(x as Record<string, unknown>)) seen.push(v);
  }
  return false;
}

describe('buildApprovalCard — pending', () => {
  const card = buildApprovalCard(REQ);

  it('uses the v2 card shape (config + header + elements)', () => {
    expect(card).toMatchObject({
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: 'Manual time request' } },
    });
    expect(Array.isArray(card.elements)).toBe(true);
  });

  it('renders Approve + Reject buttons carrying the requestId and action', () => {
    const vals = buttonValues(card);
    expect(vals).toHaveLength(2);
    expect(vals).toContainEqual({ requestId: 'req_abc', action: 'approve' });
    expect(vals).toContainEqual({ requestId: 'req_abc', action: 'reject' });
  });

  it('uses primary + danger button styling', () => {
    const action = (card.elements as Array<Record<string, unknown>>).find((e) => e.tag === 'action')!;
    const buttons = action.actions as Array<Record<string, unknown>>;
    const types = buttons.map((b) => b.type).sort();
    expect(types).toEqual(['danger', 'primary']);
  });

  it('includes the requester, task, reason, and a duration in the body', () => {
    expect(findTextContaining(card, 'Anish Suman')).toBe(true);
    expect(findTextContaining(card, 'Implement onboarding')).toBe(true);
    expect(findTextContaining(card, 'Forgot to start the tracker')).toBe(true);
    expect(findTextContaining(card, '1h 30m')).toBe(true);
  });

  it('still renders a Task line when no task is attached (shows "Untracked")', () => {
    const noTask = buildApprovalCard({ ...REQ, taskSummary: null });
    expect(findTextContaining(noTask, 'Implement onboarding')).toBe(false);
    expect(findTextContaining(noTask, 'Untracked')).toBe(true);
    expect(findTextContaining(noTask, 'Anish Suman')).toBe(true);
  });

  it('shows "<60 min" durations correctly', () => {
    const short = buildApprovalCard({ ...REQ, endedAt: REQ.startedAt + 45 * 60 * 1000 });
    expect(findTextContaining(short, '45 min')).toBe(true);
  });

  it('enables update_multi on the ORIGINAL card so the callback can replace it (avoids Lark code 200340)', () => {
    expect((card.config as Record<string, unknown>).update_multi).toBe(true);
  });

  it('JSON-serializes cleanly (Lark expects content as a JSON string)', () => {
    const s = JSON.stringify(card);
    expect(() => JSON.parse(s)).not.toThrow();
    // sanity: it's a non-trivial payload
    expect(s.length).toBeGreaterThan(200);
  });
});

describe('buildDecidedCard — post-decision', () => {
  const decidedAt = new Date('2026-05-29T11:00:00Z').getTime();

  it('shows the approved state with a green template', () => {
    const card = buildDecidedCard({ ...REQ, decision: 'APPROVED', decidedByName: 'Manager Mira', decidedAt });
    expect((card.header as Record<string, unknown>).template).toBe('green');
    expect(findTextContaining(card, 'Time approved')).toBe(true);
    expect(findTextContaining(card, 'Approved')).toBe(true);
    expect(findTextContaining(card, 'Manager Mira')).toBe(true);
  });

  it('shows the rejected state with a red template', () => {
    const card = buildDecidedCard({ ...REQ, decision: 'REJECTED', decidedByName: 'Manager Mira', decidedAt });
    expect((card.header as Record<string, unknown>).template).toBe('red');
    expect(findTextContaining(card, 'Time rejected')).toBe(true);
    expect(findTextContaining(card, 'Rejected')).toBe(true);
  });

  it('strips action buttons (no further decisions possible)', () => {
    const card = buildDecidedCard({ ...REQ, decision: 'APPROVED', decidedByName: 'M', decidedAt });
    expect(buttonValues(card)).toHaveLength(0);
  });

  it('enables update_multi so the original card can be replaced in place', () => {
    const card = buildDecidedCard({ ...REQ, decision: 'APPROVED', decidedByName: 'M', decidedAt });
    expect((card.config as Record<string, unknown>).update_multi).toBe(true);
  });
});
