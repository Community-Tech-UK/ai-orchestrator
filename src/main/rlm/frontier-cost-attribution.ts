import type { CostAttributionUsage } from '../core/system/cost-attribution';
import { recordCostAttribution } from '../core/system/cost-attribution';
import { getLocalAiCostCorrelationId } from '../local-ai-guard/local-ai-cost-correlation';
import {
  CLAUDE_PINNED_MODELS,
  GOOGLE_MODELS,
} from '../../shared/types/provider.types';
import { getTokenCounter } from './token-counter';

interface FrontierCostAttribution {
  taskType: string;
  provider: string;
  model?: string;
  inputTexts: readonly string[];
  outputText: string;
  usage?: CostAttributionUsage;
}

function tokenCount(value: number | undefined, fallback: () => number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback();
}

function pricingIdentity(provider: string, model?: string): {
  provider: string;
  model?: string;
} {
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider === 'claude') return { provider: 'anthropic', model };
  if (normalizedProvider === 'codex') return { provider: 'openai', model };
  if (normalizedProvider === 'gemini') return { provider: 'google', model };
  if (normalizedProvider !== 'antigravity') return { provider, model };

  if (model?.startsWith('Gemini 3.5 Flash')) {
    return { provider: 'google', model: GOOGLE_MODELS.GEMINI_35_FLASH };
  }
  if (model?.startsWith('Gemini 3.1 Pro')) {
    return { provider: 'google', model: GOOGLE_MODELS.GEMINI_3_1_PRO };
  }
  if (model?.startsWith('Claude Opus 4.6')) {
    return { provider: 'anthropic', model: CLAUDE_PINNED_MODELS.OPUS_46 };
  }
  if (model?.startsWith('Claude Sonnet 4.6')) {
    return { provider: 'anthropic', model: CLAUDE_PINNED_MODELS.SONNET_46 };
  }
  return { provider, model };
}

export function recordCorrelatedFrontierAttribution(
  attribution: FrontierCostAttribution,
): void {
  if (!getLocalAiCostCorrelationId()) return;
  const counter = getTokenCounter();
  const usage = attribution.usage;
  const identity = pricingIdentity(attribution.provider, attribution.model);
  recordCostAttribution({
    source: 'one-shot',
    taskType: attribution.taskType,
    provider: identity.provider,
    model: identity.model,
    usage: {
      ...usage,
      inputTokens: tokenCount(
        usage?.inputTokens,
        () => attribution.inputTexts.reduce(
          (total, text) => total + counter.countTokens(text),
          0,
        ),
      ),
      outputTokens: tokenCount(
        usage?.outputTokens,
        () => counter.countTokens(attribution.outputText),
      ),
    },
    costKnown: typeof usage?.cost === 'number'
      && Number.isFinite(usage.cost)
      && usage.cost >= 0,
  });
}
