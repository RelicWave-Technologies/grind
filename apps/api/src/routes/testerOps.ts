import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireAdmin } from '../middleware/scope';
import { buildTesterOpsUsageCard } from '../testerOps/cards';
import { loadOrCreateAiPolicy, loadOrCreateTesterOpsConfig } from '../testerOps/config';
import { replayTesterMessage } from '../testerOps/inbound';
import { refreshKnowledgeSource } from '../testerOps/knowledge';
import { enqueueTesterOpsCard } from '../testerOps/outbox';
import { buildTesterUsageSnapshot } from '../testerOps/usage';

export const testerOpsRouter = Router();
testerOpsRouter.use(requireAccessToken, attachScope, requireAdmin);

const ConfigPatch = z.object({
  enabled: z.boolean().optional(),
  chatId: z.string().min(1).nullable().optional(),
  timezone: z.string().min(1).optional(),
  pingTimes: z.array(z.string().regex(/^\d{2}:\d{2}$/)).optional(),
  passiveIssueDetectionEnabled: z.boolean().optional(),
});

const AiPolicyPatch = z.object({
  provider: z.enum(['OPENROUTER', 'DEEPSEEK']).optional(),
  model: z.string().min(1).nullable().optional(),
  promptVersion: z.string().min(1).optional(),
  temperature: z.number().min(0).max(1).optional(),
  highConfidenceThreshold: z.number().min(0).max(1).optional(),
  mediumConfidenceThreshold: z.number().min(0).max(1).optional(),
  maxClarifyingQuestions: z.number().int().min(0).max(3).optional(),
  allowedActions: z.array(z.string()).optional(),
});

testerOpsRouter.get('/config', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    res.json(await loadOrCreateTesterOpsConfig(req.scope.workspaceId));
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.put('/config', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const parsed = ConfigPatch.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid_config' });
    await loadOrCreateTesterOpsConfig(req.scope.workspaceId);
    const cfg = await prisma.testerOpsConfig.update({ where: { workspaceId: req.scope.workspaceId }, data: parsed.data });
    res.json(cfg);
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.get('/ai-policy', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    res.json(await loadOrCreateAiPolicy(req.scope.workspaceId));
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.put('/ai-policy', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const parsed = AiPolicyPatch.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid_ai_policy' });
    await loadOrCreateAiPolicy(req.scope.workspaceId);
    const policy = await prisma.testerOpsAiPolicy.update({ where: { workspaceId: req.scope.workspaceId }, data: parsed.data });
    res.json(policy);
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.get('/summary', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const cfg = await loadOrCreateTesterOpsConfig(req.scope.workspaceId);
    const [usage, issues, candidates, reminders, aiRuns] = await Promise.all([
      buildTesterUsageSnapshot(req.scope.workspaceId, cfg.timezone),
      prisma.testerOpsIssue.count({ where: { workspaceId: req.scope.workspaceId, status: 'OPEN' } }),
      prisma.testerOpsIssue.count({ where: { workspaceId: req.scope.workspaceId, status: 'CANDIDATE' } }),
      prisma.testerOpsReminder.findMany({ where: { workspaceId: req.scope.workspaceId }, orderBy: { createdAt: 'desc' }, take: 8 }),
      prisma.testerOpsAiRun.findMany({ where: { workspaceId: req.scope.workspaceId }, orderBy: { createdAt: 'desc' }, take: 8 }),
    ]);
    res.json({ usage, queues: { issues, candidates }, reminders, aiRuns });
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.get('/issues', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const issues = await prisma.testerOpsIssue.findMany({
      where: { workspaceId: req.scope.workspaceId, ...(status ? { status: status as 'OPEN' } : {}) },
      include: { reporterUser: { select: { id: true, name: true } }, aiRun: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ issues });
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.patch('/issues/:id', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const parsed = z.object({
      status: z.enum(['CANDIDATE', 'OPEN', 'RESOLVED', 'DISMISSED']).optional(),
      adminNote: z.string().max(1000).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid_issue_patch' });
    const existing = await prisma.testerOpsIssue.findFirst({ where: { id: req.params.id, workspaceId: req.scope.workspaceId } });
    if (!existing) return res.status(404).json({ error: 'issue_not_found' });
    const issue = await prisma.testerOpsIssue.update({
      where: { id: req.params.id },
      data: {
        ...parsed.data,
        ...(parsed.data.status === 'RESOLVED' || parsed.data.status === 'DISMISSED' ? { resolvedAt: new Date() } : {}),
      },
    });
    res.json(issue);
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.post('/reminders/send-now', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const cfg = await loadOrCreateTesterOpsConfig(req.scope.workspaceId);
    if (!cfg.chatId) return res.status(400).json({ error: 'missing_chat_id' });
    const usage = await buildTesterUsageSnapshot(req.scope.workspaceId, cfg.timezone);
    await prisma.$transaction(async (tx) => {
      await enqueueTesterOpsCard(tx, {
        workspaceId: req.scope!.workspaceId,
        chatId: cfg.chatId,
        card: buildTesterOpsUsageCard(usage),
        idempotencyKey: `tester-ops-status-send-now:${Date.now()}`,
      });
    });
    res.json({ queued: true, usage });
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.get('/knowledge-sources', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const sources = await prisma.testerOpsKnowledgeSource.findMany({
      where: { workspaceId: req.scope.workspaceId },
      include: { _count: { select: { chunks: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ sources });
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.put('/knowledge-sources', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const parsed = z.object({
      sources: z.array(z.object({
        id: z.string().optional(),
        title: z.string().min(1),
        token: z.string().min(6),
        url: z.string().url().nullable().optional(),
        enabled: z.boolean().optional(),
      })),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid_sources' });
    const sources = [];
    for (const source of parsed.data.sources) {
      sources.push(await prisma.testerOpsKnowledgeSource.upsert({
        where: source.id ? { id: source.id } : { workspaceId_token: { workspaceId: req.scope.workspaceId, token: source.token } },
        update: { title: source.title, token: source.token, url: source.url ?? null, enabled: source.enabled ?? true },
        create: { workspaceId: req.scope.workspaceId, title: source.title, token: source.token, url: source.url ?? null, enabled: source.enabled ?? true },
      }));
    }
    res.json({ sources });
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.post('/knowledge-sources/:id/refresh', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const source = await prisma.testerOpsKnowledgeSource.findFirst({ where: { id: req.params.id, workspaceId: req.scope.workspaceId } });
    if (!source) return res.status(404).json({ error: 'knowledge_source_not_found' });
    const result = await refreshKnowledgeSource(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.post('/ai/replay', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const parsed = z.object({ messageText: z.string().min(1), directMention: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid_replay' });
    res.json(await replayTesterMessage({ workspaceId: req.scope.workspaceId, ...parsed.data }));
  } catch (err) {
    next(err);
  }
});

testerOpsRouter.get('/health', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const [cfg, policy, latestRun, outboxFailures, staleSources] = await Promise.all([
      loadOrCreateTesterOpsConfig(req.scope.workspaceId),
      loadOrCreateAiPolicy(req.scope.workspaceId),
      prisma.testerOpsAiRun.findFirst({ where: { workspaceId: req.scope.workspaceId }, orderBy: { createdAt: 'desc' } }),
      prisma.testerOpsOutboxEvent.count({ where: { workspaceId: req.scope.workspaceId, status: { in: ['FAILED', 'DEAD_LETTER'] } } }),
      prisma.testerOpsKnowledgeSource.count({ where: { workspaceId: req.scope.workspaceId, enabled: true, OR: [{ lastFetchedAt: null }, { lastError: { not: null } }] } }),
    ]);
    res.json({
      ok: cfg.enabled && Boolean(cfg.chatId),
      bot: { enabled: cfg.enabled, chatIdConfigured: Boolean(cfg.chatId), passiveIssueDetectionEnabled: cfg.passiveIssueDetectionEnabled },
      ai: { provider: policy.provider, modelConfigured: Boolean(policy.model), lastError: latestRun?.error ?? null },
      docs: { staleSources },
      outbox: { failures: outboxFailures },
    });
  } catch (err) {
    next(err);
  }
});
