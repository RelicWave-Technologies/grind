import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { deepseek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import { env } from '../../env';

export type TimoAiProvider = 'openrouter' | 'deepseek';

export interface TimoAiSettings {
  enabled: boolean;
  provider: TimoAiProvider;
  model: string | null;
  temperature: number;
  promptVersion: string;
}

export interface TimoAiModel {
  provider: TimoAiProvider;
  modelId: string;
  model: LanguageModel;
}

export function resolveAiSettings(policy?: {
  provider?: string | null;
  model?: string | null;
  temperature?: number | null;
  promptVersion?: string | null;
}): TimoAiSettings {
  const policyProvider = policy?.provider?.toLowerCase();
  const provider = (policyProvider === 'deepseek' || policyProvider === 'openrouter'
    ? policyProvider
    : env.TIMO_AI_PROVIDER) as TimoAiProvider;
  return {
    enabled: env.TIMO_AI_ENABLED === 'true',
    provider,
    model: policy?.model ?? env.TIMO_AI_MODEL ?? null,
    temperature: policy?.temperature ?? 0.1,
    promptVersion: policy?.promptVersion ?? 'tester-ops-v1',
  };
}

export function createTimoAiModel(settings: TimoAiSettings): TimoAiModel {
  if (!settings.enabled) throw new Error('ai_disabled');
  if (!settings.model) throw new Error('ai_model_missing');
  if (settings.provider === 'deepseek') {
    if (!env.DEEPSEEK_API_KEY) throw new Error('deepseek_key_missing');
    return { provider: 'deepseek', modelId: settings.model, model: deepseek(settings.model) };
  }
  if (!env.OPENROUTER_API_KEY) throw new Error('openrouter_key_missing');
  const provider = createOpenAICompatible({
    name: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_API_KEY,
  });
  return { provider: 'openrouter', modelId: settings.model, model: provider.chatModel(settings.model) };
}
