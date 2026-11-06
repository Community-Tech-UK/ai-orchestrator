import { computeProviderTokenCost } from '../../shared/data/model-pricing';
import type { AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import { CLAUDE_PINNED_MODELS, OPENAI_MODELS } from '../../shared/types/provider.types';

export const UNKNOWN_FALLBACK_COST_USD = 0.05;
export const FALLBACK_HAIKU_MODEL = CLAUDE_PINNED_MODELS.HAIKU_46;

export interface HelperBudgetSettings {
  localAiGuardDailyFallbackBudgetUsd?: number | null;
  auxiliaryLlmDailySpendCapUsd?: number | null;
}

export function resolveHelperDailyBudgetUsd(settings: HelperBudgetSettings): number | null {
  const preferred = settings.localAiGuardDailyFallbackBudgetUsd;
  if (typeof preferred === 'number' && Number.isFinite(preferred) && preferred >= 0) return preferred;
  const inherited = settings.auxiliaryLlmDailySpendCapUsd;
  return typeof inherited === 'number' && Number.isFinite(inherited) && inherited >= 0
    ? inherited : null;
}

export interface FallbackRung { provider: string; model: string; fixedCostUsd?: number }
export interface LadderKeys { anthropic: boolean; openai: boolean }
const CLI_ESCALATED_SLOTS = new Set<AuxiliaryLlmSlot>(['titleGeneration', 'routingClassification']);

export function fallbackPriceFor(
  slot: AuxiliaryLlmSlot,
  intended?: { provider: string; model: string },
  keys: LadderKeys = { anthropic: false, openai: false },
): FallbackRung {
  if (intended?.provider && intended.model) return intended;
  if (CLI_ESCALATED_SLOTS.has(slot) || keys.anthropic) {
    return { provider: 'anthropic', model: FALLBACK_HAIKU_MODEL };
  }
  if (keys.openai) return { provider: 'openai', model: OPENAI_MODELS.GPT55_MINI };
  return { provider: 'ollama', model: 'local-summary', fixedCostUsd: 0 };
}

export function estimateFallbackCallUsd(
  rung: FallbackRung | undefined,
  tokens: { inputTokens: number; outputTokens: number },
): number {
  if (!rung) return UNKNOWN_FALLBACK_COST_USD;
  if (typeof rung.fixedCostUsd === 'number' && Number.isFinite(rung.fixedCostUsd)) return rung.fixedCostUsd;
  const price = computeProviderTokenCost(rung.provider, rung.model, tokens);
  return typeof price === 'number' && Number.isFinite(price)
    ? price : UNKNOWN_FALLBACK_COST_USD;
}
