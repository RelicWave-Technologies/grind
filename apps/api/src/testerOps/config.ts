import { prisma } from '@grind/db';
import { env } from '../env';
import { getWorkspaceTimezone } from '../workspace/timezone';

export function envPingTimes(): string[] {
  return env.TIMO_TESTER_PING_TIMES
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function loadOrCreateTesterOpsConfig(workspaceId = env.WORKSPACE_ID) {
  const timezone = await getWorkspaceTimezone(workspaceId);
  return prisma.testerOpsConfig.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      enabled: env.TIMO_TESTER_BOT_ENABLED === 'true',
      chatId: env.TIMO_TESTER_GROUP_CHAT_ID,
      timezone,
      pingTimes: envPingTimes(),
      passiveIssueDetectionEnabled: env.TIMO_PASSIVE_ISSUE_DETECTION_ENABLED === 'true',
    },
    update: { timezone },
  });
}

export async function loadOrCreateAiPolicy(workspaceId = env.WORKSPACE_ID) {
  return prisma.testerOpsAiPolicy.upsert({
    where: { workspaceId },
    update: {},
    create: {
      workspaceId,
      provider: env.TIMO_AI_PROVIDER === 'deepseek' ? 'DEEPSEEK' : 'OPENROUTER',
      model: env.TIMO_AI_MODEL,
    },
  });
}

export function isDirectMention(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('@timo') || normalized.startsWith('timo ') || normalized.includes('<at');
}
