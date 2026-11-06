import Anthropic from '@anthropic-ai/sdk';
import { prisma, type Prisma } from '@grind/db';
import { env } from '../env';
import { getLarkMessenger } from '../lark';
import { logger } from '../logger';
import { redactJson, redactText } from '../testerOps/redact';
import type { TicketActor } from '../tickets/service';
import { personBlock, SUPPORT_PROMPT_VERSION, SUPPORT_SYSTEM, type PersonContext } from './prompt';
import { dateContext, runSupportTool, SUPPORT_TOOLS, type SupportPerson, type ToolRunState } from './tools';

/**
 * Timo's support agent on Lark.
 *
 * A DM from a known person becomes one turn of a conversation with Claude:
 * the person's words (and screenshots) go in, Claude looks at their own data
 * through the tools in ./tools, and its answer goes back as a Lark message. When
 * an admin has to act, Claude asks for a ticket card, which is sent after the
 * answer; the person files it with one press.
 *
 * Conversations are kept in SupportChat so a follow-up ("aur kal ka?") carries
 * on. A quiet spell starts a fresh one. Messages that arrive while a turn is
 * running (text, then a screenshot a second later) are answered together.
 *
 * Any failure (no key, API down, refusal) falls back to the plain ticket
 * intake, so a person is never left without a way to reach an admin.
 */

const CHAT_IDLE_MS = 6 * 60 * 60 * 1000;
const MAX_STORED_MESSAGES = 80;
const MAX_TOOL_ROUNDS = 8;
const MAX_IMAGES_SENT = 8;
const BURST_WAIT_MS = 1500;
const CLAUDE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** One incoming DM as the agent needs it. */
export interface SupportDm {
  messageId: string;
  openId: string;
  text: string;
  /** Unbound TicketAttachment ids of what came with it. */
  attachmentIds: string[];
}

export interface SupportHooks {
  /** Download what came with a DM; returns attachment ids. */
  storeAttachments(dm: { messageId: string; openId: string }, raw: unknown, uploaderId: string): Promise<string[]>;
  /** Put (or refresh) a ticket card in front of the person. */
  offerDraft(actor: TicketActor, openId: string, offer: { subject: string; category: string; body: string; relatedTicketNumber: number | null; attachmentIds: string[] }): Promise<void>;
  /** The plain intake, for when the agent cannot answer. */
  fallback(actor: TicketActor, openId: string, text: string, attachmentIds: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Claude client (swappable in tests)
// ---------------------------------------------------------------------------

export type SupportCreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;
export interface SupportClaude {
  create(params: SupportCreateParams): Promise<Anthropic.Beta.BetaMessage>;
}

let realClient: Anthropic | null = null;
const realClaude: SupportClaude = {
  async create(params) {
    realClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: env.SUPPORT_AI_TIMEOUT_MS, maxRetries: 2 });
    return realClient.beta.messages.create(params);
  },
};

let testClaude: SupportClaude | null = null;
export function setSupportClaudeForTests(c: SupportClaude | null): void {
  testClaude = c;
}

/** Whether DMs go to the agent at all. Off in tests unless a fake is set. */
export function supportAgentAvailable(): boolean {
  if (testClaude) return true;
  return env.NODE_ENV !== 'test' && env.SUPPORT_AGENT_ENABLED === 'true' && Boolean(env.ANTHROPIC_API_KEY);
}

function claude(): SupportClaude {
  return testClaude ?? realClaude;
}

// ---------------------------------------------------------------------------
// Stored conversation <-> API messages
// ---------------------------------------------------------------------------

/** An image as stored: the attachment it lives in, not its bytes. */
interface StoredImage {
  type: 'image_ref';
  attachmentId: string;
}
type StoredBlock = Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaToolUseBlockParam | Anthropic.Beta.BetaToolResultBlockParam | StoredImage;
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: StoredBlock[];
}

/**
 * What is kept of an assistant turn: its words and tool calls. Thinking blocks
 * are only needed inside the turn that made them, so they are dropped here and
 * a later turn never replays them.
 */
export function storableAssistant(content: Anthropic.Beta.BetaContentBlock[]): StoredBlock[] {
  const out: StoredBlock[] = [];
  for (const b of content) {
    if (b.type === 'text' && b.text.trim()) out.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> });
  }
  return out.length ? out : [{ type: 'text', text: '(no reply)' }];
}

/** Turn stored messages into API messages, loading images from their attachments. */
export async function hydrate(messages: StoredMessage[]): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const ids = messages.flatMap((m) => m.content.filter((b): b is StoredImage => b.type === 'image_ref').map((b) => b.attachmentId));
  // Only the newest few images are worth their tokens; older ones become a note.
  const keep = new Set(ids.slice(-MAX_IMAGES_SENT));
  const rows = keep.size
    ? await prisma.ticketAttachment.findMany({ where: { id: { in: [...keep] } }, select: { id: true, mimeType: true, data: true } })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b): Anthropic.Beta.BetaContentBlockParam => {
      if (b.type !== 'image_ref') return b;
      const row = keep.has(b.attachmentId) ? byId.get(b.attachmentId) : undefined;
      // Over ~3.7 MB the base64 passes Claude's 5 MB image limit.
      if (!row || !CLAUDE_IMAGE_TYPES.has(row.mimeType) || row.data.byteLength > 3_700_000) {
        return { type: 'text', text: '[a screenshot the person sent, not shown here]' };
      }
      return {
        type: 'image',
        source: { type: 'base64', media_type: row.mimeType as 'image/png', data: Buffer.from(row.data).toString('base64') },
      };
    }),
  }));
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/**
 * Lark shows plain text: drop markdown the model may still use. In a reply
 * written in Roman letters, a stray Devanagari sign glued to a Roman word
 * ("dabा") is a slip, not Hindi, and is dropped.
 */
export function larkPlain(text: string): string {
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length;
  const deva = (text.match(/[ऀ-ॿ]/gu) ?? []).length;
  const roman = latin > 0 && deva / (latin + deva) < 0.05;
  const vowel: Record<string, string> = { 'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ं': 'n' };
  const fixSlip = (s: string) => [...s].map((ch) => vowel[ch] ?? '').join('');
  return (roman ? text.replace(/(?<=[A-Za-z])[ऀ-ॿ]+/gu, fixSlip) : text)
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/\*\*(.+?)\*\*/gu, '$1')
    .replace(/__(.+?)__/gu, '$1')
    .replace(/^\s*\*\s+/gmu, '- ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// The person
// ---------------------------------------------------------------------------

async function loadPerson(actor: TicketActor, openId: string): Promise<{ person: SupportPerson; context: PersonContext } | null> {
  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: {
      id: true,
      name: true,
      role: true,
      workspaceId: true,
      team: { select: { name: true } },
      shift: { select: { name: true, schedule: true } },
      workspace: { select: { timezone: true } },
    },
  });
  if (!user) return null;
  const timezone = user.workspace.timezone || 'Asia/Kolkata';
  const policy = await prisma.leavePolicy.findUnique({ where: { workspaceId: user.workspaceId } }).catch(() => null);
  const person: SupportPerson = { userId: user.id, workspaceId: user.workspaceId, role: user.role, name: user.name, timezone, openId };
  return {
    person,
    context: {
      name: user.name,
      role: user.role.toLowerCase(),
      team: user.team?.name ?? null,
      shift: user.shift ? shiftLabel(user.shift.name, user.shift.schedule) : null,
      timezone,
      today: dateContext(timezone).label,
      policy: policy
        ? {
            attendanceRulesFrom: policy.attendanceRulesFrom,
            fullDayMinMinutes: policy.fullDayMinMinutes,
            halfDayMinMinutes: policy.halfDayMinMinutes,
            lateGraceMinutes: policy.lateGraceMinutes,
            lateAllowedPerMonth: policy.lateAllowedPerMonth,
            halfDayLateAfterMinute: policy.halfDayLateAfterMinute,
            wfhRequiresApproval: policy.wfhRequiresApproval,
          }
        : null,
    },
  };
}

/** "General: Mon–Fri 09:30–18:30, Sat 09:30–14:00" from a weekly schedule. */
export function shiftLabel(name: string, schedule: unknown): string {
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
  const s = schedule && typeof schedule === 'object' ? (schedule as Record<string, { start?: string; end?: string } | null>) : {};
  const groups: Array<{ from: string; to: string; hours: string }> = [];
  for (const day of order) {
    const d = s[day];
    if (!d?.start || !d?.end) continue;
    const hours = `${d.start}–${d.end}`;
    const last = groups[groups.length - 1];
    const prev = order[order.indexOf(day) - 1];
    if (last && last.hours === hours && last.to === prev) last.to = day;
    else groups.push({ from: day, to: day, hours });
  }
  const cap = (d: string) => d[0]!.toUpperCase() + d.slice(1);
  const parts = groups.map((g) => `${cap(g.from)}${g.to !== g.from ? `–${cap(g.to)}` : ''} ${g.hours}`);
  return parts.length ? `${name}: ${parts.join(', ')}` : name;
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

export interface TurnResult {
  reply: string;
  offered: boolean;
  toolCalls: string[];
  failed: boolean;
}

function requestParams(messages: Anthropic.Beta.BetaMessageParam[], lastRound: boolean): SupportCreateParams {
  const tools = SUPPORT_TOOLS.map((t, i) => (i === SUPPORT_TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t));
  const params: SupportCreateParams = {
    model: env.SUPPORT_AI_MODEL,
    max_tokens: 8000,
    system: [{ type: 'text', text: SUPPORT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: tools as Anthropic.Beta.BetaToolUnion[],
    // On the last round it must answer with what it has.
    ...(lastRound ? { tool_choice: { type: 'none' as const } } : {}),
    messages,
    // Caches the conversation so far, so each tool round re-reads it cheaply.
    cache_control: { type: 'ephemeral' },
    thinking: { type: 'adaptive' },
    output_config: { effort: env.SUPPORT_AI_EFFORT },
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
  };
  return params;
}

/**
 * Run Claude over the conversation plus the new user message until it
 * answers. Returns the reply and the messages to store.
 */
export async function runTurn(
  person: SupportPerson,
  history: StoredMessage[],
  userMessage: StoredMessage,
  state: ToolRunState,
): Promise<{ result: TurnResult; stored: StoredMessage[]; usage: Record<string, number> }> {
  const stored: StoredMessage[] = [userMessage];
  const live = await hydrate([...history, userMessage]);
  const toolCalls: string[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, rounds: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const res = await claude().create(requestParams(live, round === MAX_TOOL_ROUNDS - 1));
    usage.rounds += 1;
    usage.input += res.usage.input_tokens;
    usage.output += res.usage.output_tokens;
    usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;

    if (res.stop_reason === 'refusal') {
      return { result: { reply: '', offered: false, toolCalls, failed: true }, stored, usage };
    }
    // The live copy keeps thinking blocks for the rest of this turn; the stored one does not.
    live.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    stored.push({ role: 'assistant', content: storableAssistant(res.content) });

    if (res.stop_reason === 'pause_turn') continue;
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || uses.length === 0) {
      const reply = larkPlain(textOf(res.content));
      return { result: { reply, offered: state.offer !== null, toolCalls, failed: reply.length === 0 && state.offer === null }, stored, usage };
    }

    const results = await Promise.all(
      uses.map(async (u) => {
        toolCalls.push(u.name);
        const r = await runSupportTool(person, state, u.name, u.input);
        return { type: 'tool_result' as const, tool_use_id: u.id, content: r.content, ...(r.isError ? { is_error: true } : {}) };
      }),
    );
    live.push({ role: 'user', content: results });
    stored.push({ role: 'user', content: results });
  }
  // Unreachable: the last round runs with tools off and always ends the turn.
  return { result: { reply: '', offered: state.offer !== null, toolCalls, failed: state.offer === null }, stored, usage };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

async function currentChat(person: SupportPerson) {
  const recent = await prisma.supportChat.findFirst({
    where: { userId: person.userId, lastMessageAt: { gte: new Date(Date.now() - CHAT_IDLE_MS) } },
    orderBy: { lastMessageAt: 'desc' },
  });
  const messages = (recent?.messages as unknown as StoredMessage[] | undefined) ?? [];
  if (recent && messages.length < MAX_STORED_MESSAGES) return { chat: recent, messages };
  return { chat: null, messages: [] as StoredMessage[] };
}

async function turnsToday(person: SupportPerson): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const agg = await prisma.supportChat.aggregate({ where: { userId: person.userId, lastMessageAt: { gte: since } }, _sum: { turns: true } });
  return agg._sum.turns ?? 0;
}

/**
 * Which script the reply must be in, read from the message itself. The model
 * otherwise drifts into Devanagari on a long Hinglish conversation.
 */
export function scriptHint(text: string): string | null {
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length;
  const deva = (text.match(/[ऀ-ॿ]/gu) ?? []).length;
  if (latin + deva < 2) return null;
  return deva > latin ? 'reply in Devanagari' : 'reply in Roman letters only, no Devanagari';
}

/** The opening line of each user turn: the time now, and the script to answer in. */
export function stampFor(text: string, timezone: string): string {
  const hint = scriptHint(text);
  return `[${dateContext(timezone).label}${hint ? ` · ${hint}` : ''}]`;
}

function userMessageFor(dms: SupportDm[], context: PersonContext | null, timezone: string): StoredMessage {
  const text = dms.map((d) => d.text.trim()).filter(Boolean).join('\n');
  const stamp = stampFor(text, timezone);
  const images = dms.flatMap((d) => d.attachmentIds);
  const lead = [context ? personBlock(context) : null, stamp, text || (images.length ? '(sent a screenshot)' : '(empty message)')]
    .filter(Boolean)
    .join('\n\n');
  return {
    role: 'user',
    content: [{ type: 'text', text: lead }, ...images.map((attachmentId): StoredImage => ({ type: 'image_ref', attachmentId }))],
  };
}

async function sendReply(openId: string, text: string): Promise<void> {
  const messenger = getLarkMessenger();
  if (!messenger) return;
  await messenger.sendText(openId, text).catch((err) => logger.warn({ err: String(err) }, 'support reply failed'));
}

/** Answer a burst of DMs from one person as one turn. */
export async function answerDms(actor: TicketActor, dms: SupportDm[], hooks: SupportHooks): Promise<TurnResult> {
  const openId = dms[dms.length - 1]!.openId;
  const attachmentIds = dms.flatMap((d) => d.attachmentIds);
  const allText = dms.map((d) => d.text).filter(Boolean).join('\n');
  const loaded = await loadPerson(actor, openId);
  if (!loaded) {
    await hooks.fallback(actor, openId, allText, attachmentIds);
    return { reply: '', offered: false, toolCalls: [], failed: true };
  }
  const { person, context } = loaded;

  if ((await turnsToday(person)) >= env.SUPPORT_AI_DAILY_TURNS) {
    await hooks.fallback(actor, openId, allText, attachmentIds);
    return { reply: '', offered: false, toolCalls: [], failed: true };
  }

  const { chat, messages: history } = await currentChat(person);
  const userMessage = userMessageFor(dms, history.length === 0 ? context : null, person.timezone);
  const state: ToolRunState = { offer: null };
  const started = Date.now();
  let turn: Awaited<ReturnType<typeof runTurn>> | null = null;
  let error: string | null = null;
  try {
    turn = await runTurn(person, history, userMessage, state);
  } catch (err) {
    error = err instanceof Anthropic.APIError ? `api_${err.status ?? 'error'}: ${err.message}` : String(err);
    logger.warn({ error }, 'support agent turn failed');
  }

  const result: TurnResult = turn?.result ?? { reply: '', offered: false, toolCalls: [], failed: true };
  if (result.failed) {
    await hooks.fallback(actor, openId, allText, attachmentIds);
  } else {
    if (result.reply) await sendReply(openId, result.reply);
    if (state.offer) {
      // The ticket body: Claude's summary for the admin, then the person's own words.
      const theirWords = [...history, userMessage]
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content)
        .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === 'text')
        .map((b) => b.text.replace(/<person>[\s\S]*?<\/person>\s*/u, '').replace(/^\[[^\]]+\]\s*/u, '').trim())
        .filter((t) => t && !t.startsWith('('))
        .slice(-6)
        .join('\n');
      const body = `${state.offer.details}\n\n— Their messages to Timo bot —\n${theirWords}`.slice(0, 8000);
      const chatImages = [...history, userMessage]
        .flatMap((m) => m.content)
        .filter((b): b is StoredImage => b.type === 'image_ref')
        .map((b) => b.attachmentId);
      await hooks.offerDraft(actor, openId, {
        subject: state.offer.subject,
        category: state.offer.category,
        body,
        relatedTicketNumber: state.offer.relatedTicketNumber,
        attachmentIds: chatImages,
      });
    }
  }

  // Keep the conversation, including a failed turn, so the next message has context.
  // A failed turn keeps its words but not its images: an image the API refused
  // would otherwise fail every turn after it. They went to the fallback draft.
  const failedUser: StoredMessage = {
    role: 'user',
    content: userMessage.content.map((b) => (b.type === 'image_ref' ? { type: 'text' as const, text: '[a screenshot, attached to the ticket draft]' } : b)),
  };
  const added: StoredMessage[] = turn && !result.failed
    ? turn.stored
    : [failedUser, { role: 'assistant', content: [{ type: 'text', text: '(Timo could not answer this message; the person was offered a ticket instead.)' }] }];
  const messages = [...history, ...added] as unknown as Prisma.InputJsonValue;
  if (chat) {
    await prisma.supportChat.update({ where: { id: chat.id }, data: { messages, turns: { increment: 1 }, lastMessageAt: new Date() } });
  } else {
    await prisma.supportChat.create({ data: { workspaceId: person.workspaceId, userId: person.userId, messages, turns: 1 } });
  }

  await prisma.testerOpsAiRun
    .create({
      data: {
        workspaceId: person.workspaceId,
        provider: 'anthropic',
        model: env.SUPPORT_AI_MODEL,
        promptVersion: SUPPORT_PROMPT_VERSION,
        task: 'support_chat',
        input: redactJson({ text: allText.slice(0, 2000), images: attachmentIds.length, historyMessages: history.length }) as Prisma.InputJsonValue,
        output: redactJson({ reply: result.reply.slice(0, 4000), tools: result.toolCalls, offer: state.offer, usage: turn?.usage ?? null }) as Prisma.InputJsonValue,
        error: error ? redactText(error).slice(0, 500) : result.failed ? 'no_answer' : null,
        latencyMs: Date.now() - started,
      },
    })
    .catch((err) => logger.warn({ err: String(err) }, 'support ai run not recorded'));

  return result;
}

// ---------------------------------------------------------------------------
// Per-person queue: one turn at a time, bursts answered together
// ---------------------------------------------------------------------------

/** A DM as it arrives: its attachments are downloaded when its turn comes. */
export interface IncomingDm {
  messageId: string;
  openId: string;
  text: string;
  hasResources: boolean;
  raw: unknown;
}

interface Queue {
  running: boolean;
  pending: IncomingDm[];
}
const queues = new Map<string, Queue>();

/** Wait for a short burst (a screenshot right after the text) before answering. */
let burstWaitMs = BURST_WAIT_MS;
export function setSupportBurstWaitForTests(ms: number): void {
  burstWaitMs = ms;
}

/**
 * Hand a DM to the agent. Returns at once; the answer is sent when ready.
 * `whenDone` resolves after this person's queue drains (for tests).
 */
const inFlight = new Set<Promise<void>>();

/** Resolves once no person's queue is running (tests). */
export async function supportIdleForTests(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

export function enqueueSupportDm(actor: TicketActor, dm: IncomingDm, hooks: SupportHooks): Promise<void> {
  const q = queues.get(actor.id) ?? { running: false, pending: [] };
  queues.set(actor.id, q);
  q.pending.push(dm);
  if (q.running) return Promise.resolve();
  q.running = true;
  const run = (async () => {
    try {
      await new Promise((r) => setTimeout(r, burstWaitMs));
      while (q.pending.length) {
        const batch = q.pending.splice(0);
        const dms: SupportDm[] = [];
        for (const item of batch) {
          const attachmentIds = item.hasResources ? await hooks.storeAttachments(item, item.raw, actor.id) : [];
          dms.push({ messageId: item.messageId, openId: item.openId, text: item.text, attachmentIds });
        }
        try {
          await answerDms(actor, dms, hooks);
        } catch (err) {
          logger.error({ err: String(err) }, 'support agent failed');
          await hooks
            .fallback(actor, dms[dms.length - 1]!.openId, dms.map((d) => d.text).join('\n'), dms.flatMap((d) => d.attachmentIds))
            .catch(() => undefined);
        }
      }
    } finally {
      q.running = false;
      queues.delete(actor.id);
    }
  })();
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
  return run;
}
