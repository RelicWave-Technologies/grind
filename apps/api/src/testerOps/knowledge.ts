import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '@grind/db';
import { redactText } from './redact';

const execFileAsync = promisify(execFile);

export async function refreshKnowledgeSource(sourceId: string) {
  const source = await prisma.testerOpsKnowledgeSource.findUnique({ where: { id: sourceId } });
  if (!source || !source.enabled) throw new Error('knowledge_source_not_found');
  try {
    const { stdout } = await execFileAsync(
      'lark-cli',
      ['docs', '+fetch', '--api-version', 'v2', '--doc', source.token, '--doc-format', 'markdown', '--as', 'user'],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const content = parseLarkFetch(stdout);
    const chunks = chunkMarkdown(content);
    await prisma.$transaction(async (tx) => {
      await tx.testerOpsKnowledgeChunk.deleteMany({ where: { sourceId } });
      await tx.testerOpsKnowledgeChunk.createMany({
        data: chunks.map((chunk, ordinal) => ({
          sourceId,
          ordinal,
          title: chunk.title || source.title,
          content: chunk.content,
          contentHash: sha256(chunk.content),
          tokenCount: Math.ceil(chunk.content.length / 4),
        })),
      });
      await tx.testerOpsKnowledgeSource.update({
        where: { id: sourceId },
        data: { lastFetchedAt: new Date(), lastError: null, contentHash: sha256(content) },
      });
    });
    return { chunks: chunks.length };
  } catch (err) {
    const lastError = redactText(err instanceof Error ? err.message : String(err));
    await prisma.testerOpsKnowledgeSource.update({ where: { id: sourceId }, data: { lastError } });
    throw new Error(lastError);
  }
}

export async function retrieveKnowledgeChunks(workspaceId: string, query: string, take = 8) {
  const chunks = await prisma.testerOpsKnowledgeChunk.findMany({
    where: { source: { workspaceId, enabled: true } },
    include: { source: { select: { title: true, url: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  const queryTerms = terms(query);
  return chunks
    .map((chunk) => ({
      title: chunk.title || chunk.source.title,
      url: chunk.source.url,
      content: chunk.content,
      score: scoreChunk({
        query,
        queryTerms,
        sourceTitle: chunk.source.title,
        title: chunk.title || chunk.source.title,
        content: chunk.content,
      }),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, take)
    .map(({ score: _score, ...chunk }) => chunk);
}

function parseLarkFetch(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { data?: { document?: { content?: unknown } } };
    if (typeof parsed.data?.document?.content === 'string') return parsed.data.document.content;
  } catch {
    // Some CLI versions may print markdown directly.
  }
  return stdout;
}

function chunkMarkdown(content: string): Array<{ title: string; content: string }> {
  const lines = content.split(/\r?\n/);
  const chunks: Array<{ title: string; content: string }> = [];
  let title = 'Overview';
  let buf: string[] = [];
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading && buf.join('\n').trim()) {
      chunks.push({ title, content: buf.join('\n').trim().slice(0, 4000) });
      buf = [];
      title = heading[2]!.trim();
    } else if (heading) {
      title = heading[2]!.trim();
    }
    buf.push(line);
  }
  if (buf.join('\n').trim()) chunks.push({ title, content: buf.join('\n').trim().slice(0, 4000) });
  return chunks.slice(0, 200);
}

function terms(input: string): Set<string> {
  return new Set((input.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((term) => !STOPWORDS.has(term)));
}

function scoreChunk(input: { query: string; queryTerms: Set<string>; sourceTitle: string; title: string; content: string }): number {
  const title = input.title.toLowerCase();
  const sourceTitle = input.sourceTitle.toLowerCase();
  const content = input.content.toLowerCase();
  let score = 0;
  for (const term of input.queryTerms) {
    if (title.includes(term)) score += 8;
    if (sourceTitle.includes(term)) score += 3;
    score += Math.min(6, occurrences(content, term));
  }
  const query = input.query.toLowerCase();
  if (query.includes('approval') || query.includes('approve')) {
    if (title.includes('manual-time') || title.includes('time requests')) score += 12;
    if (content.includes('manual-time approval') || content.includes('manual time approval')) score += 10;
    if (content.includes('approve') || content.includes('approver')) score += 4;
  }
  if (query.includes('edit') && (content.includes('edit') || content.includes('updated') || content.includes('supersede'))) score += 5;
  if (sourceTitle.includes('updates') || ['working', 'in progress', 'exact next action', 'progress log'].includes(title)) score *= 0.25;
  return score;
}

function occurrences(input: string, term: string): number {
  return input.split(term).length - 1;
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'how',
  'what',
  'when',
  'where',
  'why',
  'who',
  'with',
  'this',
  'that',
  'from',
  'into',
  'timo',
  'please',
]);

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
