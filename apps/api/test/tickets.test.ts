import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '@grind/db';
import { setLarkMessengerForTests, type LarkMessenger, type SendCardResult } from '../src/lark';
import { signAccessToken } from '../src/lib/jwt';

const pins = vi.hoisted(() => ({ pinned: new Set<string>(), calls: [] as string[] }));
vi.mock('../src/tickets/larkApi', async (orig) => {
  const real = await orig<typeof import('../src/tickets/larkApi')>();
  return {
    ...real,
    pinLarkMessage: async (id: string) => { pins.calls.push(`pin:${id}`); pins.pinned.add(id); },
    unpinLarkMessage: async (id: string) => { pins.calls.push(`unpin:${id}`); pins.pinned.delete(id); },
    downloadLarkMessageResource: async () => ({ data: PNG, mimeType: 'image/png' }),
  };
});

process.env.WORKSPACE_ID = 'ws_t';
const { buildApp } = await import('../src/app');
const { processTicketOutboxOnce } = await import('../src/tickets/outbox');
const { handleTicketCardAction } = await import('../src/tickets/larkActions');
const { handleTicketDm } = await import('../src/tickets/larkIntake');
const { runTicketSchedulerOnce } = await import('../src/tickets/reminders');
const { applyTicketAction, loadTicketActor } = await import('../src/tickets/service');
const { setTicketAiForTests, ruleIntake, normalizeIntake } = await import('../src/tickets/ai');
const { offerTicketFromDm } = await import('../src/tickets/larkIntake');
type TicketIntake = import('../src/tickets/ai').TicketIntake;
type IntakeInput = import('../src/tickets/ai').TicketIntakeInput;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d00000000049454e44ae426082', 'hex');

const app = buildApp();

class FakeMessenger implements LarkMessenger {
  sends: Array<{ openId: string; card: Record<string, unknown>; uuid?: string; messageId: string }> = [];
  updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  texts: Array<{ openId: string; text: string }> = [];
  unreachable = new Set<string>();
  async sendCard(openId: string, card: Record<string, unknown>, uuid?: string): Promise<SendCardResult> {
    if (this.unreachable.has(openId)) throw new Error('lark sendMessage: Bot has NO availability to this user.');
    const messageId = `om_${this.sends.length + 1}`;
    this.sends.push({ openId, card, uuid, messageId });
    return { messageId };
  }
  async sendCardToChat(): Promise<SendCardResult> { return { messageId: 'om_chat' }; }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> { this.updates.push({ messageId, card }); }
  async sendText(openId: string, text: string): Promise<SendCardResult> { this.texts.push({ openId, text }); return { messageId: `om_txt_${this.texts.length}` }; }
  async sendTextToChat(): Promise<SendCardResult> { return { messageId: 'om_txt_chat' }; }
  to(openId: string) { return this.sends.filter((s) => s.openId === openId); }
  titles(openId: string) { return this.to(openId).map((s) => (s.card.header as { title: { content: string } }).title.content); }
}

/** A stand-in for Claude: answers from `reply`, and records what it was asked. Rules by default, so no test calls the real API. */
const ai = {
  calls: [] as IntakeInput[],
  reply: (input: IntakeInput): TicketIntake => ruleIntake(input.text),
};

let fake: FakeMessenger;
beforeEach(() => {
  fake = new FakeMessenger();
  setLarkMessengerForTests(fake);
  ai.calls = [];
  ai.reply = (input) => ruleIntake(input.text);
  setTicketAiForTests({ analyze: async (input) => { ai.calls.push(input); return ai.reply(input); } });
  pins.pinned.clear();
  pins.calls.length = 0;
});
afterAll(() => {
  setLarkMessengerForTests(null);
  setTicketAiForTests(null);
});

/** Every markdown line and the ticket picker's preselection on a card. */
function cardText(card: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      if (o.tag === 'markdown' && typeof o.content === 'string') out.push(o.content);
      if (o.tag === 'button') out.push(`[${(o.text as { content?: string })?.content}]`);
      if (o.name === 'subject') out.push(`subject=${o.default_value}`);
      if (o.name === 'category') out.push(`category=${o.initial_option}`);
      if (o.name === 'ticketId') out.push(`picked=${o.initial_option ?? ''}`);
      Object.values(o).forEach(walk);
    }
  };
  walk(card);
  return out.join('\n');
}

async function drain() {
  for (let i = 0; i < 10; i += 1) {
    const n = await processTicketOutboxOnce(50, new Date(Date.now() + 60 * 60 * 1000));
    if (n === 0) break;
  }
}

async function mkUser(name: string, role: 'ADMIN' | 'MEMBER' | 'MANAGER' | 'HR', openId: string | null) {
  const user = await prisma.user.create({
    data: { workspaceId: 'ws_t', email: `${name.toLowerCase()}@co.com`, name, role, provisioningStatus: 'ACTIVE' },
  });
  if (openId) await prisma.larkIdentity.create({ data: { userId: user.id, openId } });
  return { ...user, auth: { Authorization: `Bearer ${signAccessToken({ sub: user.id, ws: 'ws_t', role })}` } };
}

async function seed() {
  await prisma.workspace.create({ data: { id: 'ws_t', name: 'W', timezone: 'Asia/Kolkata' } });
  const asha = await mkUser('Asha', 'ADMIN', 'ou_asha');
  const bilal = await mkUser('Bilal', 'ADMIN', 'ou_bilal');
  const mira = await mkUser('Mira', 'MEMBER', 'ou_mira');
  const omar = await mkUser('Omar', 'MEMBER', 'ou_omar');
  const hana = await mkUser('Hana', 'HR', 'ou_hana');
  return { asha, bilal, mira, omar, hana };
}

async function file(who: { auth: Record<string, string> }, body: Record<string, unknown> = {}) {
  const res = await request(app).post('/v1/tickets').set(who.auth).send({
    subject: 'Time missing', description: 'My Tuesday hours are gone', category: 'TIME_ATTENDANCE', ...body,
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; number: number };
}

function value(card: Record<string, unknown>, label: string): Record<string, unknown> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      if (o.tag === 'button' && (o.text as { content?: string })?.content === label) found.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(card);
  const btn = found[0];
  if (!btn) throw new Error(`no button ${label}`);
  return (btn.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value;
}

describe('tickets: the life of one', () => {
  it('a member files it, every admin gets a pinned card, and the conversation runs both ways on Lark', async () => {
    const { asha, bilal, mira } = await seed();
    const t = await file(mira);
    expect(t.number).toBe(1);
    await drain();
    expect(fake.titles('ou_asha')).toEqual(['#1 · Time missing']);
    expect(fake.titles('ou_bilal')).toEqual(['#1 · Time missing']);
    expect(fake.titles('ou_mira')).toEqual(['Ticket #1 received']);
    expect(pins.pinned.size).toBe(2);

    // Asha answers from the card form: the ticket is hers and in progress.
    const card = fake.to('ou_asha')[0]!.card;
    const reply = await handleTicketCardAction(
      { operator: { open_id: 'ou_asha' }, action: { value: value(card, 'Ask requester'), form_value: { note: 'Which Tuesday?' } } },
      value(card, 'Ask requester'),
    );
    expect(reply.toast.type).toBe('success');
    let row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.status).toBe('WAITING_ON_USER');
    expect(row.assigneeId).toBe(asha.id);
    await drain();
    expect(fake.titles('ou_mira')).toContain('Asha needs more information');

    // Mira quote-replies to that message in her DM.
    const askMsg = fake.to('ou_mira').at(-1)!;
    const handled = await handleTicketDm({
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_mira' } },
        message: { message_id: 'om_in_1', chat_type: 'p2p', chat_id: 'oc_mira', message_type: 'text', content: JSON.stringify({ text: 'The 3rd' }), parent_id: askMsg.messageId },
      },
    }, { fallback: true });
    expect(handled).toBe(true);
    row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.status).toBe('IN_PROGRESS');
    await drain();
    // The reply goes to the assignee only.
    expect(fake.titles('ou_asha')).toContain('Mira replied on #1');
    expect(fake.titles('ou_bilal')).not.toContain('Mira replied on #1');

    // Resolve from the dashboard; Mira is asked to confirm, the cards unpin.
    const resolved = await request(app).post(`/v1/tickets/${t.id}/actions`).set(asha.auth).send({ action: 'resolve', note: 'Restored the entry' });
    expect(resolved.status).toBe(200);
    await drain();
    expect(pins.pinned.size).toBe(0);
    const resolvedCard = fake.to('ou_mira').at(-1)!.card;
    expect(fake.titles('ou_mira').at(-1)).toBe('#1 resolved');

    // "Still a problem" reopens it and pins fresh cards.
    await handleTicketCardAction({ operator: { open_id: 'ou_mira' }, action: {} }, value(resolvedCard, 'Still a problem'));
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OPEN');
    await drain();
    expect(pins.pinned.size).toBe(2);
    expect(fake.titles('ou_asha')).toContain('Mira reopened #1');

    // Resolve again and confirm: closed, nobody pinned, Mira not messaged a "closed" notice.
    await applyTicketAction({ ticketId: t.id, actor: (await loadTicketActor(bilal.id))!, action: { action: 'resolve' }, via: 'DASHBOARD' });
    await drain();
    const second = fake.to('ou_mira').at(-1)!.card;
    const before = fake.to('ou_mira').length;
    await handleTicketCardAction({ operator: { open_id: 'ou_mira' }, action: {} }, value(second, 'Yes, it is fixed'));
    row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.status).toBe('CLOSED');
    expect(row.closeReason).toBe('USER_CONFIRMED');
    await drain();
    expect(fake.to('ou_mira').length).toBe(before);
    expect(pins.pinned.size).toBe(0);
  });

  it('an admin files a ticket for someone else, and they hear about it', async () => {
    const { asha, omar } = await seed();
    const t = await file(asha, { requesterId: omar.id, subject: 'Install the new Timo', priority: 'HIGH' });
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.source).toBe('ADMIN');
    expect(row.requesterId).toBe(omar.id);
    expect(row.priority).toBe('HIGH');
    await drain();
    expect(fake.titles('ou_omar')).toEqual(['Asha opened ticket #1 for you']);
    // Asha filed it but is not the requester: she still gets the admin card.
    expect(fake.titles('ou_asha')).toEqual(['#1 · Install the new Timo']);
  });

  it('a double submit with the same key files one ticket', async () => {
    const { mira } = await seed();
    const a = await file(mira, { idempotencyKey: 'key-123456' });
    const b = await file(mira, { idempotencyKey: 'key-123456' });
    expect(b.id).toBe(a.id);
    expect(await prisma.ticket.count()).toBe(1);
  });

  it('two admins resolving at once change it once', async () => {
    const { asha, bilal, mira } = await seed();
    const t = await file(mira);
    const [a, b] = await Promise.all([
      applyTicketAction({ ticketId: t.id, actor: (await loadTicketActor(asha.id))!, action: { action: 'resolve' }, via: 'LARK' }),
      applyTicketAction({ ticketId: t.id, actor: (await loadTicketActor(bilal.id))!, action: { action: 'resolve' }, via: 'LARK' }),
    ]);
    expect([a.changed, b.changed].sort()).toEqual([false, true]);
    expect(await prisma.ticketEvent.count({ where: { ticketId: t.id, toStatus: 'RESOLVED' } })).toBe(1);
  });

  it('closes a duplicate with a pointer to the original', async () => {
    const { asha, mira, omar } = await seed();
    await file(mira);
    const dup = await file(omar);
    const res = await request(app).post(`/v1/tickets/${dup.id}/actions`).set(asha.auth).send({ action: 'duplicate', ofNumber: 1 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CLOSED');
    expect(res.body.closeReason).toBe('DUPLICATE');
    expect(res.body.duplicateOf.number).toBe(1);
    // The requester cannot reopen a duplicate.
    const reopen = await request(app).post(`/v1/tickets/${dup.id}/actions`).set(omar.auth).send({ action: 'reopen' });
    expect(reopen.status).toBe(409);
  });
});

describe('tickets: who may do what', () => {
  it('keeps tickets private to the requester and admins, and admin-only actions admin-only', async () => {
    const { asha, mira, omar, hana } = await seed();
    const t = await file(mira);
    expect((await request(app).get(`/v1/tickets/${t.id}`).set(omar.auth)).status).toBe(404);
    expect((await request(app).get('/v1/tickets?scope=all').set(omar.auth)).status).toBe(403);
    // HR's extra is People only; tickets are an admin's.
    expect((await request(app).get('/v1/tickets?scope=all').set(hana.auth)).status).toBe(403);
    expect((await request(app).get(`/v1/tickets/${t.id}`).set(hana.auth)).status).toBe(404);
    expect((await request(app).post(`/v1/tickets/${t.id}/actions`).set(mira.auth).send({ action: 'resolve' })).status).toBe(403);
    expect((await request(app).post(`/v1/tickets/${t.id}/comments`).set(mira.auth).send({ body: 'x', internal: true })).status).toBe(403);
    expect((await request(app).post('/v1/tickets').set(mira.auth).send({ subject: 'For Omar', description: 'x', requesterId: omar.id })).status).toBe(403);

    // An internal note is for admins only.
    await request(app).post(`/v1/tickets/${t.id}/comments`).set(asha.auth).send({ body: 'Probably a sync bug', internal: true });
    const asRequester = await request(app).get(`/v1/tickets/${t.id}`).set(mira.auth);
    expect(asRequester.body.events.some((e: { kind: string }) => e.kind === 'INTERNAL_NOTE')).toBe(false);
    const asAdmin = await request(app).get(`/v1/tickets/${t.id}`).set(asha.auth);
    expect(asAdmin.body.events.some((e: { kind: string }) => e.kind === 'INTERNAL_NOTE')).toBe(true);
    await drain();
    // …and never reaches the requester on Lark.
    expect(fake.titles('ou_mira')).toEqual(['Ticket #1 received']);

    // A Lark card click by a non-admin does nothing.
    const card = fake.to('ou_asha')[0]!.card;
    const r = await handleTicketCardAction({ operator: { open_id: 'ou_omar' }, action: { form_value: { note: 'hi' } } }, value(card, 'Resolve'));
    expect(r.toast.type).toBe('error');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OPEN');
  });

  it('lets the requester reopen only within the window', async () => {
    const { asha, mira } = await seed();
    const t = await file(mira);
    await request(app).post(`/v1/tickets/${t.id}/actions`).set(asha.auth).send({ action: 'close' });
    await prisma.ticket.update({ where: { id: t.id }, data: { closedAt: new Date(Date.now() - 8 * 86_400_000) } });
    const late = await request(app).post(`/v1/tickets/${t.id}/actions`).set(mira.auth).send({ action: 'reopen' });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('reopen_window_passed');
    const byAdmin = await request(app).post(`/v1/tickets/${t.id}/actions`).set(asha.auth).send({ action: 'reopen' });
    expect(byAdmin.body.status).toBe('OPEN');
  });

  it('flags a requester Timo cannot reach on Lark instead of retrying forever', async () => {
    const { mira } = await seed();
    fake.unreachable.add('ou_mira');
    const t = await file(mira);
    await drain();
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.requesterUnreachable).toBe(true);
    expect(await prisma.ticketOutboxEvent.count({ where: { status: { not: 'DONE' } } })).toBe(0);
    // The admins' card says so.
    const ashaCard = fake.to('ou_asha')[0]!;
    const latest = fake.updates.filter((u) => u.messageId === ashaCard.messageId).at(-1)?.card ?? ashaCard.card;
    expect(JSON.stringify(latest)).toContain('cannot message this person');
  });
});

describe('tickets: from a Lark DM', () => {
  const dm = (text: string, id: string, extra: Record<string, unknown> = {}) => ({
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_mira' } },
      message: { message_id: id, chat_type: 'p2p', chat_id: 'oc_mira', message_type: 'text', content: JSON.stringify({ text }), ...extra },
    },
  });

  it('"ticket …" plus a screenshot becomes a ticket on [Open ticket], and a redelivery is ignored', async () => {
    const { mira } = await seed();
    expect(await handleTicketDm(dm('ticket Timo stops every hour', 'om_a'), { fallback: true })).toBe(true);
    expect(await handleTicketDm(dm('ticket Timo stops every hour', 'om_a'), { fallback: true })).toBe(true);
    expect(await prisma.ticketDraft.count()).toBe(1);
    await handleTicketDm({
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_mira' } },
        message: { message_id: 'om_b', chat_type: 'p2p', message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }) },
      },
    }, { fallback: true });
    const draft = await prisma.ticketDraft.findFirstOrThrow({ include: { _count: { select: { attachments: true } } } });
    expect(draft.text).toBe('Timo stops every hour');
    expect(draft._count.attachments).toBe(1);

    const offer = fake.to('ou_mira').at(-1)!.card;
    const open = value(offer, 'Open ticket');
    const res = await handleTicketCardAction({ operator: { open_id: 'ou_mira' }, action: { value: open, form_value: { subject: 'Timo stops', category: 'TIMO_APP' } } }, open);
    expect(res.toast.content).toBe('Ticket #1 opened.');
    const ticket = await prisma.ticket.findFirstOrThrow({ include: { _count: { select: { attachments: true } } } });
    expect(ticket).toMatchObject({ source: 'LARK', category: 'TIMO_APP', subject: 'Timo stops', requesterId: mira.id });
    expect(ticket._count.attachments).toBe(1);
    // Pressing it again does not open a second ticket.
    await handleTicketCardAction({ operator: { open_id: 'ou_mira' }, action: { value: open, form_value: {} } }, open);
    expect(await prisma.ticket.count()).toBe(1);
  });

  it('leaves ordinary messages to the tester bot when it is on, and drafts them when it is off', async () => {
    await seed();
    expect(await handleTicketDm(dm('what is my time today?', 'om_c'), { fallback: true })).toBe(false);
    expect(await handleTicketDm(dm('my leave is wrong', 'om_d'), { fallback: false })).toBe(true);
    expect((await prisma.ticketDraft.findFirstOrThrow()).text).toBe('my leave is wrong');
  });

  it('ignores people Timo does not know', async () => {
    await seed();
    const res = await handleTicketDm({
      event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_stranger' } }, message: { message_id: 'om_s', chat_type: 'p2p', message_type: 'text', content: '{"text":"ticket hi"}' } },
    }, { fallback: false });
    expect(res).toBe(false);
  });
});

describe('tickets: Timo AI reads a Lark draft', () => {
  const dm = (text: string, id: string, extra: Record<string, unknown> = {}) => ({
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_mira' } },
      message: { message_id: id, chat_type: 'p2p', chat_id: 'oc_mira', message_type: 'text', content: JSON.stringify({ text }), ...extra },
    },
  });
  const image = (id: string) => ({
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_mira' } },
      message: { message_id: id, chat_type: 'p2p', message_type: 'image', content: JSON.stringify({ image_key: `img_${id}` }) },
    },
  });
  const read = (over: Partial<TicketIntake>): TicketIntake => ({ kind: 'PROBLEM', subject: 'x', category: 'OTHER', relatedTicketId: null, question: null, fromAi: true, ...over });

  it('fills the card with its subject and category, and [Open ticket] files them when the form comes back empty', async () => {
    const { mira } = await seed();
    ai.reply = () => read({ subject: '3 hours missing on 5 Nov 2026', category: 'TIME_ATTENDANCE' });
    await handleTicketDm(dm('ticket kal ka 3 ghante ka time gayab hai', 'om_1'), { fallback: true });
    expect(ai.calls[0]).toMatchObject({ text: 'kal ka 3 ghante ka time gayab hai', openTickets: [] });
    expect(ai.calls[0]!.today).toMatch(/\d{4}$/u);
    const card = fake.to('ou_mira').at(-1)!.card;
    expect(cardText(card)).toContain('subject=3 hours missing on 5 Nov 2026');
    expect(cardText(card)).toContain('category=TIME_ATTENDANCE');
    const open = value(card, 'Open ticket');
    await handleTicketCardAction({ operator: { open_id: 'ou_mira' }, action: { value: open, form_value: {} } }, open);
    // The person's own words stay the description; only the title and category come from the AI.
    expect(await prisma.ticket.findFirstOrThrow()).toMatchObject({
      subject: '3 hours missing on 5 Nov 2026', category: 'TIME_ATTENDANCE', description: 'kal ka 3 ghante ka time gayab hai', requesterId: mira.id,
    });
  });

  it('what the person types on the card wins over the AI', async () => {
    await seed();
    ai.reply = () => read({ subject: 'AI title', category: 'TIMO_APP' });
    await handleTicketDm(dm('ticket app band ho gaya', 'om_1'), { fallback: true });
    const open = value(fake.to('ou_mira').at(-1)!.card, 'Open ticket');
    await handleTicketCardAction({ operator: { open_id: 'ou_mira' }, action: { value: open, form_value: { subject: 'My own title', category: 'OTHER' } } }, open);
    expect(await prisma.ticket.findFirstOrThrow()).toMatchObject({ subject: 'My own title', category: 'OTHER' });
  });

  it('keeps working on the plain rules when the AI fails or throws', async () => {
    await seed();
    ai.reply = () => { throw new Error('model down'); };
    expect(await handleTicketDm(dm('ticket my leave balance is wrong', 'om_1'), { fallback: true })).toBe(true);
    const card = fake.to('ou_mira').at(-1)!.card;
    expect(cardText(card)).toContain('subject=my leave balance is wrong');
    expect(cardText(card)).toContain('category=LEAVE_PAYROLL');
    // Nothing was cached, so the next message asks the model again.
    expect((await prisma.ticketDraft.findFirstOrThrow()).aiTextHash).toBeNull();
  });

  it('answers small talk instead of opening a draft when the tester bot is off', async () => {
    await seed();
    ai.reply = () => read({ kind: 'CHITCHAT', subject: 'Greeting' });
    expect(await handleTicketDm(dm('hi', 'om_1'), { fallback: false })).toBe(true);
    expect(await prisma.ticketDraft.count()).toBe(0);
    expect(fake.texts.at(-1)?.text).toMatch(/tell me what happened/u);
    // …but if the model cannot answer, a message still becomes a draft rather than being dropped.
    ai.reply = (input) => ruleIntake(input.text);
    await handleTicketDm(dm('hi again', 'om_2'), { fallback: false });
    expect(await prisma.ticketDraft.count()).toBe(1);
  });

  it('"ticket hi" is still a draft: the keyword is the person asking for one', async () => {
    await seed();
    ai.reply = () => read({ kind: 'CHITCHAT' });
    await handleTicketDm(dm('ticket hi', 'om_1'), { fallback: false });
    expect(await prisma.ticketDraft.count()).toBe(1);
  });

  it('points at the open ticket it is about, preselects it, and [Add to #N] adds the message there', async () => {
    const { mira } = await seed();
    const sync = await file(mira, { subject: 'Sync failed every morning', category: 'TIMO_APP' });
    ai.reply = () => read({ kind: 'FOLLOW_UP', subject: 'Sync failed again', category: 'TIMO_APP', relatedTicketId: sync.id });
    await handleTicketDm(dm('ticket still not fixed, aaj bhi wahi error', 'om_1'), { fallback: true });
    expect(ai.calls[0]!.openTickets).toEqual([{ id: sync.id, number: sync.number, subject: 'Sync failed every morning', category: 'TIMO_APP' }]);
    const card = fake.to('ou_mira').at(-1)!.card;
    const text = cardText(card);
    expect(text).toContain(`This looks like your open ticket **#${sync.number}`);
    expect(text).toContain(`picked=${sync.id}`);
    expect(text.indexOf(`[Add to #${sync.number}]`)).toBeLessThan(text.indexOf('[Open new ticket]'));
    const add = value(card, `Add to #${sync.number}`);
    // Lark may send the form back without the preselected value; the AI's match stands in.
    await handleTicketCardAction({ operator: { open_id: 'ou_mira' }, action: { value: add, form_value: {} } }, add);
    expect(await prisma.ticket.count()).toBe(1);
    const comment = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: sync.id, kind: 'COMMENT' } });
    expect(comment.body).toBe('still not fixed, aaj bhi wahi error');
  });

  it('drops a match to a ticket that has closed since', async () => {
    const { mira, asha } = await seed();
    const t = await file(mira);
    ai.reply = () => read({ kind: 'FOLLOW_UP', relatedTicketId: t.id });
    await handleTicketDm(dm('ticket same problem', 'om_1'), { fallback: true });
    const actor = await loadTicketActor(asha.id);
    await applyTicketAction({ ticketId: t.id, actor: actor!, action: { action: 'close' }, via: 'DASHBOARD' });
    await handleTicketDm(image('om_2'), { fallback: true });
    // The screenshot refreshes the same card in place.
    const text = cardText(fake.updates.at(-1)!.card);
    expect(text).not.toContain('This looks like');
    expect(text).toContain('[Open ticket]');
  });

  it('shows its question, reads the draft again when the person answers, and not when only a screenshot arrives', async () => {
    await seed();
    ai.reply = (input) => input.text.includes('4 Nov')
      ? read({ subject: 'Manual time for 4 Nov rejected', category: 'TIME_ATTENDANCE' })
      : read({ subject: 'Manual time rejected', category: 'TIME_ATTENDANCE', question: 'Kis din ki request thi?' });
    await handleTicketDm(dm('ticket manual time reject ho gaya', 'om_1'), { fallback: true });
    expect(cardText(fake.to('ou_mira').at(-1)!.card)).toContain('💡 Kis din ki request thi?');
    await handleTicketDm(dm('4 Nov ki', 'om_2'), { fallback: true });
    expect(ai.calls.map((c) => c.text)).toEqual(['manual time reject ho gaya', 'manual time reject ho gaya\n4 Nov ki']);
    const after = cardText(fake.updates.at(-1)!.card);
    expect(after).toContain('subject=Manual time for 4 Nov rejected');
    expect(after).not.toContain('💡');
    await handleTicketDm(image('om_3'), { fallback: true });
    expect(ai.calls).toHaveLength(2);
  });

  it('a problem the tester bot spots gets the same reading', async () => {
    await seed();
    ai.reply = () => read({ subject: 'Leave balance wrong', category: 'LEAVE_PAYROLL' });
    expect(await offerTicketFromDm('ou_mira', 'mera PL galat dikh raha hai')).toBe(true);
    expect(cardText(fake.to('ou_mira').at(-1)!.card)).toContain('subject=Leave balance wrong');
  });

  it('only matches the person\'s own tickets', async () => {
    const { omar } = await seed();
    const theirs = await file(omar);
    ai.reply = () => read({ kind: 'FOLLOW_UP', relatedTicketId: theirs.id });
    await handleTicketDm(dm('ticket any update?', 'om_1'), { fallback: true });
    expect(cardText(fake.to('ou_mira').at(-1)!.card)).not.toContain('This looks like');
  });
});

describe('tickets: cleaning what the AI says', () => {
  const open = [{ id: 't6', number: 6, subject: 'Sync failed', category: 'TIMO_APP' as const }];
  const raw = { kind: 'PROBLEM' as const, subject: 'Ticket: Hours missing.', category: 'TIME_ATTENDANCE' as const, relatedTicketNumber: null, followUpQuestion: null, language: 'English' };

  it('strips a "Ticket:" prefix and a trailing full stop, and clips a long title', () => {
    expect(normalizeIntake(raw, { text: 'x', openTickets: [] }).subject).toBe('Hours missing');
    const long = normalizeIntake({ ...raw, subject: 'a'.repeat(300) }, { text: 'x', openTickets: [] }).subject;
    expect(long.length).toBe(120);
    expect(long.endsWith('…')).toBe(true);
  });

  it('ignores a ticket number that is not one of theirs, and keeps one that is', () => {
    expect(normalizeIntake({ ...raw, relatedTicketNumber: 99 }, { text: 'x', openTickets: open }).relatedTicketId).toBeNull();
    expect(normalizeIntake({ ...raw, relatedTicketNumber: 6 }, { text: 'x', openTickets: open }).relatedTicketId).toBe('t6');
  });

  it('never asks a question of small talk, and falls back to the first line for an empty title', () => {
    const r = normalizeIntake({ ...raw, kind: 'CHITCHAT', subject: ' ', followUpQuestion: 'Why?' }, { text: 'hello there', openTickets: [] });
    expect(r.question).toBeNull();
    expect(r.subject).toBe('hello there');
  });
});

describe('tickets: reminders and auto-close', () => {
  // 11:30 IST: inside messaging hours.
  const at = (offsetH: number) => new Date(Date.UTC(2026, 10, 6, 6, 0) + offsetH * 3_600_000);

  it('reminds admins after 4h with no answer, at most three times', async () => {
    const { mira } = await seed();
    const t = await file(mira);
    await prisma.ticket.update({ where: { id: t.id }, data: { lastUserActivityAt: at(-5), createdAt: at(-5) } });
    await prisma.ticketDigest.create({ data: { workspaceId: 'ws_t', day: '2026-11-06' } });
    await runTicketSchedulerOnce(at(0));
    await runTicketSchedulerOnce(at(0));
    expect(await prisma.ticketOutboxEvent.count({ where: { kind: 'ADMIN_REMINDER' } })).toBe(1);
    await runTicketSchedulerOnce(at(4));
    await runTicketSchedulerOnce(at(8));
    await runTicketSchedulerOnce(at(12));
    expect(await prisma.ticketOutboxEvent.count({ where: { kind: 'ADMIN_REMINDER' } })).toBe(3);
  });

  it('asks the requester again, then closes a resolved ticket after 3 quiet days', async () => {
    const { asha, mira } = await seed();
    const t = await file(mira);
    await applyTicketAction({ ticketId: t.id, actor: (await loadTicketActor(asha.id))!, action: { action: 'resolve' }, via: 'DASHBOARD', now: at(-25) });
    await prisma.ticketDigest.create({ data: { workspaceId: 'ws_t', day: '2026-11-06' } });
    await runTicketSchedulerOnce(at(0));
    expect(await prisma.ticketOutboxEvent.count({ where: { kind: 'USER_REMINDER' } })).toBe(1);
    await runTicketSchedulerOnce(at(1));
    expect(await prisma.ticketOutboxEvent.count({ where: { kind: 'USER_REMINDER' } })).toBe(1);
    await runTicketSchedulerOnce(at(50));
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.status).toBe('CLOSED');
    expect(row.closeReason).toBe('AUTO_CONFIRMED');
  });

  it('sends nothing at night', async () => {
    const { mira } = await seed();
    const t = await file(mira);
    await prisma.ticket.update({ where: { id: t.id }, data: { lastUserActivityAt: at(-10) } });
    await runTicketSchedulerOnce(new Date(Date.UTC(2026, 10, 6, 18, 0))); // 23:30 IST
    expect(await prisma.ticketOutboxEvent.count({ where: { kind: 'ADMIN_REMINDER' } })).toBe(0);
  });

  it('sends one digest a day to the ticket admins', async () => {
    await seed();
    const { mira } = { mira: await prisma.user.findFirstOrThrow({ where: { name: 'Mira' } }) };
    const actor = (await loadTicketActor(mira.id))!;
    const { createTicket } = await import('../src/tickets/service');
    await createTicket({ actor, subject: 'Hello there', description: 'x', category: 'OTHER', via: 'DASHBOARD' });
    await runTicketSchedulerOnce(new Date(Date.UTC(2026, 10, 6, 5, 0))); // 10:30 IST
    await runTicketSchedulerOnce(new Date(Date.UTC(2026, 10, 6, 7, 0)));
    expect(fake.titles('ou_asha').filter((t) => t.startsWith('Support tickets'))).toHaveLength(1);
    expect(fake.titles('ou_mira').filter((t) => t.startsWith('Support tickets'))).toHaveLength(0);
  });
});

describe('tickets: attachments', () => {
  function multipart(data: Buffer, name: string, type: string) {
    const boundary = 'XBOUNDARY';
    return {
      boundary,
      body: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    };
  }

  it('uploads, binds and serves a screenshot only to the people on the ticket', async () => {
    const { asha, mira, omar } = await seed();
    const { boundary, body } = multipart(PNG, 'shot.png', 'image/png');
    const up = await request(app).post('/v1/tickets/attachments').set(mira.auth)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`).send(body);
    expect(up.status).toBe(201);
    expect(up.body.mimeType).toBe('image/png');
    // Someone else cannot bind Mira's upload.
    const stolen = await request(app).post('/v1/tickets').set(omar.auth).send({ subject: 'Mine now', description: 'x', attachmentIds: [up.body.id] });
    expect(stolen.status).toBe(400);
    const t = await file(mira, { attachmentIds: [up.body.id] });
    const detail = await request(app).get(`/v1/tickets/${t.id}`).set(mira.auth);
    expect(detail.body.attachments).toHaveLength(1);
    expect((await request(app).get(up.body.url).set(mira.auth)).status).toBe(200);
    expect((await request(app).get(up.body.url).set(asha.auth)).status).toBe(200);
    expect((await request(app).get(up.body.url).set(omar.auth)).status).toBe(404);
  });

  it('refuses a page dressed up as an image', async () => {
    const { mira } = await seed();
    const { boundary, body } = multipart(Buffer.from('<html><script>alert(1)</script></html>'), 'x.png', 'image/png');
    const up = await request(app).post('/v1/tickets/attachments').set(mira.auth)
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`).send(body);
    expect(up.status).toBe(415);
  });
});
