import type { DocAnswer, TesterDecision } from './ai/brain';
import type { buildTesterUsageSnapshot } from './usage';
import { env } from '../env';

type Card = Record<string, unknown>;
type Element = Record<string, unknown>;
type UsageSnapshot = Awaited<ReturnType<typeof buildTesterUsageSnapshot>>;
type CardTemplate =
  | 'blue'
  | 'wathet'
  | 'turquoise'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'carmine'
  | 'violet'
  | 'purple'
  | 'indigo'
  | 'grey'
  | 'default';
type TagColor = 'neutral' | 'blue' | 'turquoise' | 'lime' | 'orange' | 'violet' | 'indigo' | 'wathet' | 'green' | 'yellow' | 'red' | 'purple' | 'carmine';

interface Citation {
  title: string;
  url: string | null;
}

interface TextTag {
  text: string;
  color: TagColor;
}

interface HeaderIcon {
  token: string;
  preferMascot?: boolean;
}

const MAX_MD = 2600;

const PROGRESS_FRAMES = [
  { title: 'Timo is checking', subtitle: 'Reading the right notes', icon: 'loading_outlined', state: 'Looking for the part that answers you' },
  { title: 'Timo is checking.', subtitle: 'Finding useful steps', icon: 'search_outlined', state: 'Matching your question to the product flow' },
  { title: 'Timo is checking..', subtitle: 'Shaping the answer', icon: 'richtext_outlined', state: 'Turning this into simple steps' },
  { title: 'Timo is checking...', subtitle: 'Polishing reply', icon: 'edit-continue_outlined', state: 'Keeping it crisp and useful' },
];

export function buildTesterOpsThinkingCard(input: { prompt: string; mode?: string; frame?: number }): Card {
  const frame = PROGRESS_FRAMES[Math.abs(input.frame ?? 0) % PROGRESS_FRAMES.length]!;
  const hasStreamingImage = hasTesterOpsStreamingImage();
  return baseCard({
    title: hasStreamingImage ? 'Timo is checking' : frame.title,
    subtitle: hasStreamingImage ? 'Working on your answer' : frame.subtitle,
    template: 'indigo',
    icon: hasStreamingImage ? undefined : { token: frame.icon, preferMascot: true },
    summary: 'Timo is preparing your answer',
    tags: [{ text: 'Working', color: 'violet' }],
    elements: [
      streamingImage(),
      markdown(`**Question**\n> ${safeInline(input.prompt, 700)}`, { elementId: 'question', margin: '0 0 2px 0' }),
      markdown(safeBlock(`${frame.state}. I will keep this crisp and focused on what helps you act.`, 400), { elementId: 'progress', textSize: 'notation' }),
    ],
  });
}

export function hasTesterOpsStreamingImage(): boolean {
  return Boolean(streamingImageKey());
}

export function buildTesterOpsDocAnswerCard(input: {
  question: string;
  answer: DocAnswer;
  evidenceCount: number;
}): Card {
  const answerText = input.answer.answer ?? input.answer.missingInfo ?? input.answer.refusalReason ?? 'I could not verify this from the allowed docs.';
  const hasAnswer = Boolean(input.answer.answer);
  const { lead, body } = splitAnswer(answerText);
  return baseCard({
    title: hasAnswer ? 'Timo answer' : 'Timo needs context',
    subtitle: hasAnswer ? 'Simple answer from Grind docs' : 'Not enough evidence in allowed docs',
    template: hasAnswer ? 'green' : 'orange',
    icon: { token: hasAnswer ? 'safe-pass_outlined' : 'info_outlined' },
    summary: hasAnswer ? lead : 'Timo could not verify the answer from docs',
    tags: [{ text: hasAnswer ? 'Answered' : 'Needs docs', color: hasAnswer ? 'green' : 'orange' }],
    elements: [
      markdown(`**You asked**\n> ${safeInline(input.question, 600)}`, { elementId: 'question', textSize: 'notation' }),
      markdown(`## ${safeInline(lead, 500)}`, { elementId: 'answer_lead', textSize: 'heading-4', margin: '2px 0 0 0' }),
      body ? markdown(safeBlock(body, 1800), { elementId: 'answer_body' }) : null,
      sourceBlock(input.answer.citations),
      hasAnswer ? null : smallText('Timo needs a clearer product note for this.'),
    ],
  });
}

export function buildTesterOpsUsageCard(snapshot: UsageSnapshot): Card {
  const tracking = snapshot.totals.testers > 0 ? snapshot.totals.trackingNow / snapshot.totals.testers : 0;
  const totalMinutes = snapshot.testers.reduce((sum, tester) => sum + tester.trackedMinutes, 0);
  const totalScreenshots = snapshot.testers.reduce((sum, tester) => sum + tester.screenshots, 0);
  return baseCard({
    title: 'Tester status',
    subtitle: `${snapshot.date} · ${snapshot.timezone}`,
    template: snapshot.totals.silent > 0 ? 'orange' : 'green',
    icon: { token: snapshot.totals.silent > 0 ? 'alarm-clock_outlined' : 'check_outlined' },
    summary: `${snapshot.totals.trackingNow}/${snapshot.totals.testers} testers tracking now`,
    tags: [
      { text: `${percent(tracking)} live`, color: tracking >= 0.8 ? 'green' : tracking >= 0.5 ? 'orange' : 'red' },
      { text: `${snapshot.totals.silent} silent`, color: snapshot.totals.silent > 0 ? 'orange' : 'neutral' },
    ],
    elements: [
      metricTable('usage_metrics', [
        ['Tracking now', `${snapshot.totals.trackingNow}/${snapshot.totals.testers}`, `${percent(tracking)} live coverage`],
        ['Silent today', String(snapshot.totals.silent), 'No time or screenshots yet'],
        ['Tracked time', minutesLabel(totalMinutes), 'Across all testers today'],
        ['Screenshots', String(totalScreenshots), 'Captured today'],
      ]),
      testerPersonList(snapshot),
      testerTable(snapshot),
      smallText(`Generated ${formatLocalDateTime(snapshot.generatedAt, snapshot.timezone)}.`),
    ],
  });
}

export function buildTesterOpsPingCard(snapshot: UsageSnapshot): Card {
  const tracking = snapshot.totals.testers > 0 ? snapshot.totals.trackingNow / snapshot.totals.testers : 0;
  return baseCard({
    title: 'Testing check-in',
    subtitle: 'Please share blockers in this thread',
    template: snapshot.totals.silent > 0 ? 'orange' : 'blue',
    icon: { token: 'bell_outlined' },
    summary: 'Timo testing check-in',
    tags: [
      { text: `${snapshot.totals.trackingNow}/${snapshot.totals.testers} live`, color: tracking >= 0.8 ? 'green' : 'orange' },
      { text: `${snapshot.totals.silent} silent`, color: snapshot.totals.silent > 0 ? 'orange' : 'neutral' },
    ],
    elements: [
      markdown('## Please test the tracker now\nPost anything broken here. If something fails, include what you tried, what happened, and whether a screenshot is available.', { elementId: 'ping_main', textSize: 'heading-4' }),
      markdown(safeBlock([
        `Tracking now: ${snapshot.totals.trackingNow}/${snapshot.totals.testers} (${percent(tracking)} live)`,
        `Silent today: ${snapshot.totals.silent}`,
        '',
        'What to check:',
        '- Start tracker and confirm the timer runs.',
        '- Confirm screenshots capture/upload.',
        '- Try manual time if that is part of your test.',
        '- Report blockers directly in this thread.',
      ].join('\n'), 900), { elementId: 'ping_list' }),
    ],
  });
}

export function buildTesterOpsIssueCard(input: { decision: TesterDecision; status: string; sourceText: string }): Card {
  const critical = input.decision.severity === 'HIGH' || input.decision.severity === 'CRITICAL';
  return baseCard({
    title: input.status === 'OPEN' ? 'Issue logged' : 'Issue candidate',
    subtitle: input.status === 'OPEN' ? 'Saved to Tester Ops' : 'Saved for dashboard review',
    template: critical ? 'red' : input.status === 'OPEN' ? 'orange' : 'grey',
    icon: { token: critical ? 'report_outlined' : 'info_outlined' },
    summary: input.decision.summary,
    tags: [
      { text: input.status, color: input.status === 'OPEN' ? 'orange' : 'neutral' },
      { text: input.decision.severity, color: severityColor(input.decision.severity) },
    ],
    elements: [
      markdown(`## ${safeInline(input.decision.summary, 700)}`, { elementId: 'issue_summary', textSize: 'heading-4' }),
      input.decision.category ? markdown(`**Area**\n${safeBlock(input.decision.category, 160)}`, { elementId: 'issue_area', textSize: 'notation' }) : null,
      input.decision.clarifyingQuestion ? markdown(`**One thing I need**\n${safeBlock(input.decision.clarifyingQuestion, 500)}`, { elementId: 'clarifier' }) : null,
      markdown(`**Source message**\n> ${safeInline(input.sourceText, 900)}`, { elementId: 'source', textSize: 'notation' }),
      smallText('Keep replying in this thread with more details; Tester Ops will keep the audit trail.'),
    ],
  });
}

export function buildTesterOpsGeneralCard(input: {
  title: string;
  text: string;
  template?: CardTemplate;
  citations?: Citation[];
}): Card {
  return baseCard({
    title: input.title,
    subtitle: 'Timo',
    template: input.template ?? 'blue',
    icon: { token: 'info_outlined' },
    summary: input.text,
    elements: [
      markdown(safeBlock(input.text, 1900), { elementId: 'general' }),
      sourceBlock(input.citations ?? []),
    ],
  });
}

function baseCard(input: {
  title: string;
  subtitle?: string;
  template: CardTemplate;
  icon?: HeaderIcon;
  summary: string;
  tags?: TextTag[];
  streaming?: boolean;
  elements: Array<Element | null>;
}): Card {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
      enable_forward: true,
      summary: { content: clean(input.summary, 120) },
      ...(input.streaming
        ? {
            streaming_mode: true,
            streaming_config: {
              print_frequency_ms: { default: 35, android: 35, ios: 35, pc: 25 },
              print_step: { default: 2, android: 2, ios: 2, pc: 4 },
              print_strategy: 'fast',
            },
          }
        : {}),
    },
    header: {
      title: { tag: 'plain_text', content: clean(input.title, 80) },
      ...(input.subtitle ? { subtitle: { tag: 'plain_text', content: clean(input.subtitle, 80) } } : {}),
      ...(input.tags?.length ? { text_tag_list: input.tags.slice(0, 3).map(textTag) } : {}),
      ...(input.icon ? { icon: headerIcon(input.icon, input.template) } : {}),
      template: input.template,
      padding: '12px 16px 12px 16px',
    },
    body: {
      direction: 'vertical',
      padding: '14px 16px 16px 16px',
      vertical_spacing: '8px',
      horizontal_align: 'left',
      elements: input.elements.filter(Boolean),
    },
  };
}

function markdown(content: string, opts: { elementId: string; textSize?: string; margin?: string }): Element {
  return {
    tag: 'markdown',
    element_id: opts.elementId.slice(0, 20),
    content: clean(content, MAX_MD),
    text_size: opts.textSize ?? 'normal',
    margin: opts.margin ?? '0',
  };
}

function smallText(content: string): Element {
  return markdown(safeBlock(content, 500), { elementId: uniqueElementId('small'), textSize: 'notation', margin: '4px 0 0 0' });
}

function metricTable(elementId: string, rows: Array<[string, string, string]>): Element {
  return {
    tag: 'table',
    element_id: elementId.slice(0, 20),
    page_size: Math.min(Math.max(rows.length, 1), 10),
    row_height: 'middle',
    header_style: {
      text_align: 'left',
      text_size: 'normal',
      background_style: 'grey',
      text_color: 'grey',
      bold: true,
      lines: 1,
    },
    columns: [
      { name: 'metric', display_name: 'Metric', data_type: 'text', width: '34%', horizontal_align: 'left', vertical_align: 'center' },
      { name: 'value', display_name: 'Now', data_type: 'text', width: '22%', horizontal_align: 'left', vertical_align: 'center' },
      { name: 'detail', display_name: 'Detail', data_type: 'text', width: '44%', horizontal_align: 'left', vertical_align: 'center' },
    ],
    rows: rows.map(([metric, value, detail]) => ({
      metric: clean(metric, 60),
      value: clean(value, 60),
      detail: clean(detail, 120),
    })),
  };
}

function testerTable(snapshot: UsageSnapshot): Element {
  const testers = snapshot.testers.slice(0, 10);
  const usePersonColumn = testers.length > 0 && testers.every((tester) => tester.openId);
  return {
    tag: 'table',
    element_id: 'tester_table',
    page_size: Math.min(Math.max(testers.length, 1), 10),
    row_height: 'low',
    freeze_first_column: true,
    header_style: {
      text_align: 'left',
      text_size: 'normal',
      background_style: 'grey',
      text_color: 'grey',
      bold: true,
      lines: 1,
    },
    columns: [
      { name: 'name', display_name: 'Tester', data_type: usePersonColumn ? 'persons' : 'text', width: '34%', horizontal_align: 'left', vertical_align: 'center' },
      { name: 'time', display_name: 'Time', data_type: 'text', width: '18%', horizontal_align: 'left', vertical_align: 'center' },
      { name: 'shots', display_name: 'Shots', data_type: 'number', width: '16%', horizontal_align: 'center', vertical_align: 'center', format: { precision: 0 } },
      { name: 'state', display_name: 'State', data_type: 'options', width: '32%', horizontal_align: 'left', vertical_align: 'center' },
    ],
    rows: testers.length > 0
      ? testers.map((tester) => ({
          name: usePersonColumn ? personCell(tester.openId) : clean(tester.name, 80),
          time: minutesLabel(tester.trackedMinutes),
          shots: tester.screenshots,
          state: [{ text: stateLabel(tester.agentState), color: stateColor(tester.agentState) }],
        }))
      : [{ name: 'No testers yet', time: '-', shots: 0, state: [{ text: 'WAITING', color: 'neutral' }] }],
  };
}

function testerPersonList(snapshot: UsageSnapshot): Element | null {
  const persons = snapshot.testers
    .map((tester) => tester.openId)
    .filter((openId): openId is string => Boolean(openId))
    .slice(0, 12)
    .map((id) => ({ id }));
  if (persons.length === 0) return null;
  return {
    tag: 'person_list',
    element_id: 'tester_people',
    size: 'medium',
    show_name: true,
    drop_invalid_user_id: 'true',
    persons,
  };
}

function personCell(openId: string | null): Array<{ id: string }> {
  return openId ? [{ id: openId }] : [];
}

function sourceBlock(citations: Citation[]): Element | null {
  const unique = citations
    .filter((citation, index, arr) => citation.title && arr.findIndex((item) => item.title === citation.title && item.url === citation.url) === index)
    .slice(0, 4);
  if (unique.length === 0) return null;
  const lines = unique.map((citation) => {
    const title = safeInline(citation.title, 90);
    return `- ${title}`;
  });
  return markdown(`**Sources I used**\n${lines.join('\n')}`, { elementId: 'sources', textSize: 'notation', margin: '2px 0 0 0' });
}

function textTag(input: TextTag): Element {
  return {
    tag: 'text_tag',
    text: { tag: 'plain_text', content: clean(input.text, 24) },
    color: input.color,
  };
}

function headerIcon(icon: HeaderIcon, template: CardTemplate): Element {
  const imageKey = icon.preferMascot ? env.TIMO_CARD_MASCOT_IMAGE_KEY?.trim() : null;
  if (imageKey?.startsWith('img_')) return { tag: 'custom_icon', img_key: imageKey };
  return { tag: 'standard_icon', token: icon.token, color: template };
}

function streamingImage(): Element | null {
  const imageKey = streamingImageKey();
  if (!imageKey) return null;
  return {
    tag: 'img',
    element_id: 'timo_stream_gif',
    img_key: imageKey,
    alt: { tag: 'plain_text', content: 'Timo is working on the answer' },
    preview: false,
  };
}

function streamingImageKey(): string | null {
  const imageKey = (env.TIMO_CARD_STREAMING_IMAGE_KEY ?? env.TIMO_CARD_MASCOT_IMAGE_KEY)?.trim();
  return imageKey?.startsWith('img_') ? imageKey : null;
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function severityColor(severity: TesterDecision['severity']): TagColor {
  if (severity === 'CRITICAL') return 'red';
  if (severity === 'HIGH') return 'orange';
  if (severity === 'MEDIUM') return 'yellow';
  return 'green';
}

function stateLabel(state: string | null): string {
  if (state === 'RUNNING') return 'RUNNING';
  if (state === 'PAUSED') return 'PAUSED';
  if (state === 'STOPPED') return 'STOPPED';
  return 'UNKNOWN';
}

function stateColor(state: string | null): TagColor {
  if (state === 'RUNNING') return 'green';
  if (state === 'PAUSED') return 'orange';
  if (state === 'STOPPED') return 'neutral';
  return 'red';
}

function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function splitAnswer(value: string): { lead: string; body: string } {
  const trimmed = value.trim();
  const lines = trimmed.split(/\n+/u);
  const first = lines[0]?.trim() ?? trimmed;
  if (lines.length > 1 && first.length <= 220) {
    return { lead: first.replace(/[:：]\s*$/u, '') || 'Answer', body: prettifyAnswer(lines.slice(1).join('\n').trim()) };
  }
  const sentence = trimmed.match(/^(.{24,180}?[.!?])\s+/u)?.[1];
  const lead = (sentence ?? first.slice(0, 180)).replace(/[:：]\s*$/u, '') || 'Answer';
  const body = trimmed.slice(lead.length).trim().replace(/^[:：]\s*/u, '');
  return { lead, body: prettifyAnswer(body) };
}

function prettifyAnswer(value: string): string {
  return value
    .replace(/(\S)(\*\*(?:Steps|Caveats|Next action|Next step)[^*]*:\*\*)/giu, '$1\n\n$2')
    .replace(/(\*\*(?:Steps|Caveats|Next action|Next step)[^*]*:\*\*)\s*-/giu, '$1\n-')
    .replace(/(\S)(\*\*Caveats:\*\*)/giu, '$1\n\n$2')
    .replace(/(\S)(\*\*Next action:\*\*)/giu, '$1\n\n$2')
    .trim();
}

function safeBlock(value: string, max: number): string {
  return escapeCardMd(clean(value, max));
}

function safeInline(value: string, max: number): string {
  return escapeCardMd(clean(value.replace(/\s+/gu, ' '), max));
}

function escapeCardMd(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&#60;')
    .replace(/>/gu, '&#62;');
}

function uniqueElementId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`.slice(0, 20);
}

function formatLocalDateTime(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function clean(value: string, max: number): string {
  const compact = value.replace(/\s+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1).trimEnd()}...`;
}
