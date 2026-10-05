import { prisma } from '@grind/db';

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
