import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@grind/db';
import { addDays, todayKey } from '@grind/types';
import { setLarkMessengerForTests, type LarkMessenger, type SendCardResult } from '../src/lark';

vi.mock('../src/tickets/larkApi', async (orig) => {
  const real = await orig<typeof import('../src/tickets/larkApi')>();
  return {
    ...real,
    pinLarkMessage: async () => undefined,
    unpinLarkMessage: async () => undefined,
    downloadLarkMessageResource: async () => ({ data: PNG, mimeType: 'image/png' }),
  };
});

process.env.WORKSPACE_ID = 'ws_s';
const { handleTicketDm } = await import('../src/tickets/larkIntake');
const { setSupportClaudeForTests, setSupportBurstWaitForTests, supportIdleForTests, storableAssistant, larkPlain, shiftLabel, scriptHint } = await import('../src/support/agent');
const { condenseDayInsight, condenseReportDay, fmtDuration, runSupportTool } = await import('../src/support/tools');
const { stopSelfApi } = await import('../src/support/selfApi');
const { setTicketAiForTests, ruleIntake } = await import('../src/tickets/ai');
type Params = import('../src/support/agent').SupportCreateParams;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d00000000049454e44ae426082', 'hex');
const TZ = 'Asia/Kolkata';

class FakeMessenger implements LarkMessenger {
  sends: Array<{ openId: string; card: Record<string, unknown>; messageId: string }> = [];
  updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  texts: Array<{ openId: string; text: string }> = [];
  order: string[] = [];
  async sendCard(openId: string, card: Record<string, unknown>): Promise<SendCardResult> {
    const messageId = `om_${this.sends.length + 1}`;
    this.sends.push({ openId, card, messageId });
    this.order.push('card');
    return { messageId };
  }
  async sendCardToChat(): Promise<SendCardResult> { return { messageId: 'om_chat' }; }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> { this.updates.push({ messageId, card }); this.order.push('card-update'); }
  async sendText(openId: string, text: string): Promise<SendCardResult> { this.texts.push({ openId, text }); this.order.push('text'); return { messageId: `om_t${this.texts.length}` }; }
  async sendTextToChat(): Promise<SendCardResult> { return { messageId: 'om_tc' }; }
}

/** A scripted Claude: each call gets the next step, and every request is recorded. */
type Step = (p: Params) => { content: Array<Record<string, unknown>>; stop: Anthropic.Beta.BetaStopReason } | Error;
const claude = { steps: [] as Step[], calls: [] as Params[] };
function msg(content: Array<Record<string, unknown>>, stop: Anthropic.Beta.BetaStopReason): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_${claude.calls.length}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const text = (t: string) => ({ type: 'text', text: t });
const thinking = { type: 'thinking', thinking: '', signature: 'sig' };

let fake: FakeMessenger;
beforeEach(() => {
  fake = new FakeMessenger();
  setLarkMessengerForTests(fake);
  claude.steps = [];
  claude.calls = [];
  setSupportBurstWaitForTests(0);
  setTicketAiForTests({ analyze: async (input) => ruleIntake(input.text) });
  setSupportClaudeForTests({
    async create(params) {
      // Snapshot: the loop keeps appending to the same array.
      claude.calls.push(JSON.parse(JSON.stringify(params)) as Params);
      const step = claude.steps.shift();
      if (!step) throw new Error('no scripted step left');
      const out = step(params);
      if (out instanceof Error) throw out;
      return msg(out.content, out.stop);
    },
  });
});
afterAll(async () => {
  setSupportClaudeForTests(null);
  setLarkMessengerForTests(null);
  setTicketAiForTests(null);
  await stopSelfApi();
});

async function seed() {
  await prisma.workspace.create({ data: { id: 'ws_s', name: 'W', timezone: TZ } });
  const shift = await prisma.shift.create({
    data: {
      workspaceId: 'ws_s',
      name: 'General',
      bufferMin: 0,
      schedule: {
        mon: { start: '09:30', end: '18:30' }, tue: { start: '09:30', end: '18:30' }, wed: { start: '09:30', end: '18:30' },
        thu: { start: '09:30', end: '18:30' }, fri: { start: '09:30', end: '18:30' }, sat: null, sun: null,
      },
    },
  });
  const mk = async (name: string, openId: string) => {
    const user = await prisma.user.create({
      data: { workspaceId: 'ws_s', email: `${name.toLowerCase()}@co.com`, name, role: 'MEMBER', provisioningStatus: 'ACTIVE', shiftId: shift.id, shiftAssignedAt: new Date('2026-01-01T00:00:00Z') },
    });
    await prisma.larkIdentity.create({ data: { userId: user.id, openId } });
    return user;
  };
  const mira = await mk('Mira', 'ou_mira');
  const omar = await mk('Omar', 'ou_omar');
  // Mira worked 10:00–12:30 yesterday (local); Omar worked a full 8h the same day.
  const day = addDays(todayKey(TZ), -1);
  const at = (hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
  const entry = async (userId: string, from: string, to: string) =>
    prisma.timeEntry.create({
      data: {
        id: `te_${userId}_${from}`.slice(0, 26),
        clientUuid: `cu_${userId}_${from}`,
        userId,
        source: 'AUTO',
        startedAt: at(from),
        endedAt: at(to),
        segments: { create: { id: `sg_${userId}_${from}`.slice(0, 26), kind: 'WORK', startedAt: at(from), endedAt: at(to) } },
      },
    });
  await entry(mira.id, '10:00', '12:30');
  await entry(omar.id, '09:30', '17:30');
  return { mira, omar, day };
}

function dm(openId: string, id: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: openId } },
      message: { message_id: id, chat_type: 'p2p', chat_id: `oc_${openId}`, message_type: 'text', content: JSON.stringify({ text: body }), ...extra },
    },
  };
}

function lastToolResult(p: Params): string {
  const last = p.messages.at(-1)!;
  const block = (last.content as Array<Record<string, unknown>>).find((b) => b.type === 'tool_result')!;
  return String(block.content);
}

describe('support agent: formatting', () => {
  it('turns milliseconds and blocks into what a support person reads', () => {
    expect(fmtDuration(3 * 3600_000 + 28 * 60_000)).toBe('3h 28m');
    expect(fmtDuration(45 * 60_000)).toBe('45m');
    expect(fmtDuration(2 * 3600_000)).toBe('2h');
    const day = condenseDayInsight({
      date: '2026-11-04', isFuture: false, isToday: false,
      shift: { name: 'General', start: '09:30', end: '18:30' },
      firstActivityAt: Date.parse('2026-11-04T04:30:00Z'), lastActivityAt: Date.parse('2026-11-04T07:00:00Z'),
      totals: { workedMs: 9_000_000, meetingMs: 0, manualMs: 0, idleTrimmedMs: 0, pendingMs: 0, gapMs: 23_400_000, invalidatedMs: 0 },
      blocks: [
        { kind: 'GAP', startedAt: Date.parse('2026-11-04T04:00:00Z'), endedAt: Date.parse('2026-11-04T04:30:00Z'), durationMs: 1_800_000 },
        { kind: 'WORK', startedAt: Date.parse('2026-11-04T04:30:00Z'), endedAt: Date.parse('2026-11-04T07:00:00Z'), durationMs: 9_000_000 },
      ],
      recentRejected: [],
    }, TZ);
    expect(day.day).toBe('Wed 4 Nov 2026');
    expect(day.firstActivity).toBe('10:00');
    expect(day.totals.counted).toBe('2h 30m');
    expect(day.timeline).toEqual([
      { what: 'gap', from: '09:30', to: '10:00', length: '30m' },
      { what: 'work', from: '10:00', to: '12:30', length: '2h 30m' },
    ]);
    const report = condenseReportDay({
      date: '2026-11-04', workedMs: 9_000_000, meetingMs: 0, manualMs: 0, firstActivityMs: null, lastActivityMs: null,
      punchInMinute: 615, punchOutMinute: null, shiftStatus: 'late', approvals: { approved: 0, pending: 1, rejected: 0 },
      dayStatus: { kind: 'WORKING', portion: null, label: null, shiftName: 'General', expectedFraction: 1 },
      attendanceCode: 'PL_HD', attendanceRule: { tag: 'SHORT_DAY', penaltyDays: 0.5 },
    }, TZ);
    expect(report.officePunchIn).toBe('10:15');
    expect(report.attendance).toBe('PL_HD (half day paid leave)');
    expect(report.ruleApplied).toContain('half day');
  });

  it('keeps words and tool calls of a turn, never its thinking', () => {
    const kept = storableAssistant([
      { type: 'thinking', thinking: 'secret', signature: 's' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 't1', name: 'get_day', input: { date: '2026-11-04' } },
    ] as unknown as Anthropic.Beta.BetaContentBlock[]);
    expect(kept.map((b) => b.type)).toEqual(['text', 'tool_use']);
  });

  it('strips markdown Lark would show raw, and names a shift by its days', () => {
    expect(larkPlain('## Done\n**4 Nov** par\n* step one')).toBe('Done\n4 Nov par\n- step one');
    // A Devanagari slip inside Hinglish goes; real Hindi stays.
    expect(larkPlain('Card check karke "Open ticket" dabा dein.')).toBe('Card check karke "Open ticket" dabaa dein.');
    expect(larkPlain('कल मेरी छुट्टी क्यों लगी? Lark में देखें')).toBe('कल मेरी छुट्टी क्यों लगी? Lark में देखें');
    // Each turn names the script to answer in, read from the message.
    expect(scriptHint('restart bhi kiya, phir bhi crash')).toBe('reply in Roman letters only, no Devanagari');
    expect(scriptHint('कल मेरी छुट्टी क्यों लगी?')).toBe('reply in Devanagari');
    expect(scriptHint('👍')).toBeNull();
    expect(shiftLabel('General', {
      mon: { start: '09:30', end: '18:30' }, tue: { start: '09:30', end: '18:30' }, wed: { start: '09:30', end: '18:30' },
      thu: { start: '09:30', end: '18:30' }, fri: { start: '09:30', end: '18:30' }, sat: { start: '09:30', end: '14:00' }, sun: null,
    })).toBe('General: Mon–Fri 09:30–18:30, Sat 09:30–14:00');
  });
});

describe('support agent: a conversation on Lark', () => {
  it('reads the asker\'s own day before answering, and replies in Lark', async () => {
    const { mira, day } = await seed();
    claude.steps = [
      () => ({ content: [thinking, toolUse('tu_1', 'get_day', { date: day })], stop: 'tool_use' }),
      (p) => {
        // The tool answered from Mira's own data: 2h 30m, not Omar's 8h.
        const got = JSON.parse(lastToolResult(p));
        expect(got.totals.work).toBe('2h 30m');
        expect(got.firstActivity).toBe('10:00');
        return { content: [text('Kal 10:00 se 12:30 tak hi track hua, **2h 30m**.')], stop: 'end_turn' };
      },
    ];
    expect(await handleTicketDm(dm('ou_mira', 'om_1', 'kal ka time kam dikha raha hai'), { fallback: true })).toBe(true);
    await supportIdleForTests();

    expect(fake.texts).toEqual([{ openId: 'ou_mira', text: 'Kal 10:00 se 12:30 tak hi track hua, 2h 30m.' }]);
    expect(fake.sends).toHaveLength(0);

    // The first message carries who she is and today's date; the system prompt and tools are cached.
    const first = claude.calls[0]!;
    const opening = JSON.stringify(first.messages[0]!.content);
    expect(opening).toContain('<person>');
    expect(opening).toContain('name: Mira');
    expect(opening).toContain('General: Mon–Fri 09:30–18:30');
    expect(opening).toContain('kal ka time kam dikha raha hai');
    expect(first.model).toBe('claude-sonnet-5-5');
    expect(first.thinking).toEqual({ type: 'adaptive' });
    expect((first.system as Array<{ cache_control?: unknown }>)[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(first.tools!.every((t) => !('input_schema' in t) || !JSON.stringify(t.input_schema).includes('user_id'))).toBe(true);
    // Within the turn the thinking block goes back unchanged.
    expect(JSON.stringify(claude.calls[1]!.messages.at(-2))).toContain('"thinking"');

    const chat = await prisma.supportChat.findFirstOrThrow({ where: { userId: mira.id } });
    expect(chat.turns).toBe(1);
    expect(JSON.stringify(chat.messages)).not.toContain('"thinking"');
    const run = await prisma.testerOpsAiRun.findFirstOrThrow({ where: { task: 'support_chat' } });
    expect(run.error).toBeNull();
    expect((run.output as { tools: string[] }).tools).toEqual(['get_day']);
  });

  it('carries the conversation on, without repeating who the person is', async () => {
    await seed();
    claude.steps = [
      () => ({ content: [text('Haan, batao kya hua?')], stop: 'end_turn' }),
      (p) => {
        expect(p.messages).toHaveLength(3);
        expect(JSON.stringify(p.messages[0])).toContain('<person>');
        expect(JSON.stringify(p.messages[2])).not.toContain('<person>');
        expect(JSON.stringify(p.messages[2])).toContain('app band ho gaya');
        return { content: [text('Main check karta hoon.')], stop: 'end_turn' };
      },
    ];
    await handleTicketDm(dm('ou_mira', 'om_a', 'hi'), { fallback: true });
    await supportIdleForTests();
    await handleTicketDm(dm('ou_mira', 'om_b', 'app band ho gaya'), { fallback: true });
    await supportIdleForTests();
    expect(fake.texts.map((t) => t.text)).toEqual(['Haan, batao kya hua?', 'Main check karta hoon.']);
  });

  it('offers a ticket after its reply, with the screenshot, and files nothing by itself', async () => {
    const { mira, day } = await seed();
    claude.steps = [
      (p) => {
        // The screenshot reaches Claude as an image.
        expect(JSON.stringify(p.messages[0]!.content)).toContain('"type":"image"');
        return { content: [toolUse('tu_1', 'get_my_tickets', {})], stop: 'tool_use' };
      },
      () => ({
        content: [toolUse('tu_2', 'offer_ticket', {
          subject: `Tracked time missing on ${day}`,
          category: 'TIME_ATTENDANCE',
          details: 'She says she worked 10:00–18:30; Timo shows only 10:00–12:30 tracked. App last seen yesterday. Admin should check whether entries failed to sync.',
          related_ticket_number: null,
        })],
        stop: 'tool_use',
      }),
      () => ({ content: [text('Yeh admin ko dekhna padega. Neeche ticket card bheja hai, Open ticket dabao.')], stop: 'end_turn' }),
    ];
    await handleTicketDm(dm('ou_mira', 'om_img', '', { message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }) }), { fallback: true });
    await supportIdleForTests();

    expect(fake.order).toEqual(['text', 'card']);
    const draft = await prisma.ticketDraft.findFirstOrThrow({ where: { userId: mira.id }, include: { attachments: true } });
    expect(draft.status).toBe('OPEN');
    expect(draft.aiSubject).toBe(`Tracked time missing on ${day}`);
    expect(draft.aiCategory).toBe('TIME_ATTENDANCE');
    expect(draft.text).toContain('Admin should check');
    expect(draft.attachments).toHaveLength(1);
    expect(await prisma.ticket.count()).toBe(0);
    expect(JSON.stringify(fake.sends[0]!.card)).toContain('Open ticket');

    // Pressing Open ticket on that card files it, with the screenshot.
    const { handleTicketCardAction } = await import('../src/tickets/larkActions');
    const reply = await handleTicketCardAction(
      { operator: { open_id: 'ou_mira' }, action: { form_value: { subject: draft.aiSubject, category: 'TIME_ATTENDANCE' } } },
      { kind: 'ticket', action: 'open_draft', draftId: draft.id },
    );
    expect(reply.toast.type).toBe('success');
    const ticket = await prisma.ticket.findFirstOrThrow({ include: { attachments: true } });
    expect(ticket.subject).toBe(`Tracked time missing on ${day}`);
    expect(ticket.attachments).toHaveLength(1);
  });

  it('sends the card again at the bottom when asked, and retires the old one', async () => {
    const { mira } = await seed();
    const offer = (id: string) => () => ({
      content: [toolUse(id, 'offer_ticket', { subject: 'App not reporting', category: 'TIMO_APP', details: 'App silent since 5 Nov.', related_ticket_number: null })],
      stop: 'tool_use' as const,
    });
    const done = () => ({ content: [text('Card neeche bhej diya hai.')], stop: 'end_turn' as const });
    claude.steps = [offer('tu_1'), done];
    await handleTicketDm(dm('ou_mira', 'om_a', 'i want to raise a ticket'), { fallback: true });
    await supportIdleForTests();
    claude.steps = [offer('tu_2'), done];
    await handleTicketDm(dm('ou_mira', 'om_b', 'firse bhejna'), { fallback: true });
    await supportIdleForTests();

    // Two cards were sent; the first now points down to the second.
    expect(fake.sends.map((s) => s.messageId)).toEqual(['om_1', 'om_2']);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]!.messageId).toBe('om_1');
    expect(JSON.stringify(fake.updates[0]!.card)).toContain('Updated ticket card below');
    const draft = await prisma.ticketDraft.findFirstOrThrow({ where: { userId: mira.id } });
    expect(draft.offerMessageId).toBe('om_2');
    expect(await prisma.ticketDraft.count()).toBe(1);
  });

  it('falls back to the plain intake when Claude is down', async () => {
    const { mira } = await seed();
    claude.steps = [() => new Error('overloaded')];
    await handleTicketDm(dm('ou_mira', 'om_x', 'mera kal ka attendance galat hai'), { fallback: true });
    await supportIdleForTests();
    expect(fake.texts[0]!.text).toContain('could not look into this');
    const draft = await prisma.ticketDraft.findFirstOrThrow({ where: { userId: mira.id } });
    expect(draft.text).toBe('mera kal ka attendance galat hai');
    expect(fake.sends).toHaveLength(1);
    const run = await prisma.testerOpsAiRun.findFirstOrThrow({ where: { task: 'support_chat' } });
    expect(run.error).toContain('overloaded');
    // The next message still has the failed one in its history.
    claude.steps = [(p) => {
      expect(JSON.stringify(p.messages)).toContain('mera kal ka attendance galat hai');
      return { content: [text('ok')], stop: 'end_turn' };
    }];
    await handleTicketDm(dm('ou_mira', 'om_y', 'hello?'), { fallback: true });
    await supportIdleForTests();
  });

  it('a refusal also falls back', async () => {
    await seed();
    claude.steps = [() => ({ content: [], stop: 'refusal' })];
    await handleTicketDm(dm('ou_mira', 'om_r', 'help'), { fallback: true });
    await supportIdleForTests();
    expect(fake.sends.length + fake.texts.length).toBeGreaterThan(0);
  });

  it('answers with what it has once the tool rounds run out', async () => {
    const { day } = await seed();
    claude.steps = Array.from({ length: 7 }, (_, i) => () => ({ content: [toolUse(`tu_${i}`, 'get_day', { date: day })], stop: 'tool_use' as const }));
    claude.steps.push((p) => {
      expect(p.tool_choice).toEqual({ type: 'none' });
      return { content: [text('Itna hi mila.')], stop: 'end_turn' };
    });
    await handleTicketDm(dm('ou_mira', 'om_loop', 'check karo'), { fallback: true });
    await supportIdleForTests();
    expect(fake.texts.map((t) => t.text)).toEqual(['Itna hi mila.']);
  });

  it('a redelivered Lark event is answered once', async () => {
    await seed();
    claude.steps = [() => ({ content: [text('Hi!')], stop: 'end_turn' })];
    await handleTicketDm(dm('ou_mira', 'om_dup', 'hi'), { fallback: true });
    await handleTicketDm(dm('ou_mira', 'om_dup', 'hi'), { fallback: true });
    await supportIdleForTests();
    expect(claude.calls).toHaveLength(1);
  });

  it('a stranger (no Timo account) never reaches the agent', async () => {
    await seed();
    expect(await handleTicketDm(dm('ou_nobody', 'om_s', 'hi'), { fallback: true })).toBe(false);
    await supportIdleForTests();
    expect(claude.calls).toHaveLength(0);
  });
});

describe('support agent: tools stay on the asker', () => {
  it('reads only the sender, whatever the model puts in the input', async () => {
    const { mira, omar, day } = await seed();
    const person = (u: { id: string; name: string }, openId: string) => ({ userId: u.id, workspaceId: 'ws_s', role: 'MEMBER' as const, name: u.name, timezone: TZ, openId });
    const state = { offer: null };
    // Extra fields are ignored: there is no way to name someone else.
    const asMira = JSON.parse((await runSupportTool(person(mira, 'ou_mira'), state, 'get_day', { date: day, userId: omar.id })).content);
    const asOmar = JSON.parse((await runSupportTool(person(omar, 'ou_omar'), state, 'get_day', { date: day })).content);
    expect(asMira.totals.work).toBe('2h 30m');
    expect(asOmar.totals.work).toBe('8h');
  });

  it('turns bad input into a message for the model, not a crash', async () => {
    const { mira } = await seed();
    const p = { userId: mira.id, workspaceId: 'ws_s', role: 'MEMBER' as const, name: 'Mira', timezone: TZ, openId: 'ou_mira' };
    const bad = await runSupportTool(p, { offer: null }, 'get_day', { date: '2026-02-31' });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('real date');
    const wide = await runSupportTool(p, { offer: null }, 'get_days', { from: '2026-01-01', to: '2026-03-01' });
    expect(wide.content).toContain('at most 31 days');
    const status = JSON.parse((await runSupportTool(p, { offer: null }, 'get_app_status', {})).content);
    expect(status.installed).toBe(false);
  });
});
