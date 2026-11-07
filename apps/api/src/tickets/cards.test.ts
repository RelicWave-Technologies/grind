import { describe, it, expect } from 'vitest';
import { buildAdminTicketCard, buildDraftCard } from './cards';

/** Every interactive element inside a form, wherever it sits (columns included). */
function formFields(node: unknown, inForm = false, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const n of node) formFields(n, inForm, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const el = node as Record<string, unknown>;
  const here = inForm || el.tag === 'form';
  if (inForm && ['button', 'input', 'select_static', 'multi_select_static', 'date_picker', 'checker'].includes(String(el.tag))) out.push(el);
  for (const v of Object.values(el)) formFields(v, here, out);
  return out;
}

function expectNamed(card: Record<string, unknown>) {
  const fields = formFields(card);
  expect(fields.length).toBeGreaterThan(0);
  // Lark refuses a form click with error 200530 when any of these has no name.
  for (const f of fields) expect(typeof f.name === 'string' && f.name.length > 0, JSON.stringify(f).slice(0, 120)).toBe(true);
  const names = fields.map((f) => f.name);
  expect(new Set(names).size).toBe(names.length);
}

describe('ticket cards: forms Lark accepts', () => {
  it('names every field and button in the draft card form', () => {
    const base = { draftId: 'd1', text: 'App stopped', attachmentCount: 0, suggestedSubject: 'App stopped', suggestedCategory: 'TIMO_APP' as const };
    expectNamed(buildDraftCard({ ...base, openTickets: [] }));
    const open = [{ id: 't1', number: 4, subject: 'Hours missing' }];
    expectNamed(buildDraftCard({ ...base, openTickets: open, related: open[0] }));
  });

  it('names every field and button in the admin card form', () => {
    expectNamed(buildAdminTicketCard({
      ticketId: 't1', number: 4, subject: 'Hours missing', description: 'd', category: 'TIMO_APP', priority: 'NORMAL', status: 'OPEN',
      closeReason: null, requesterName: 'Mira', requesterTeam: null, requesterUnit: null, requesterVersion: null, requesterUnreachable: false,
      createdByName: null, assigneeName: null, attachmentCount: 0, createdAt: Date.now(), timeZone: 'Asia/Kolkata', latest: null,
    }));
  });
});
