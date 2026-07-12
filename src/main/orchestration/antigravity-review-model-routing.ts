import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../shared/types/provider-quota.types';

const MAX_QUOTA_SNAPSHOT_AGE_MS = 15 * 60_000;

export const ANTIGRAVITY_REVIEW_FALLBACK_MODELS = {
  SONNET: 'Claude Sonnet 4.6 (Thinking)',
  GPT_OSS: 'GPT-OSS 120B (Medium)',
} as const;

function isGeminiModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase().startsWith('gemini ') ?? false;
}

function isGeminiWindow(window: ProviderQuotaWindow): boolean {
  return window.id.toLowerCase().includes('.gemini-')
    || window.label.trim().toLowerCase().startsWith('gemini ·');
}

function isThirdPartyWindow(window: ProviderQuotaWindow): boolean {
  return window.id.toLowerCase().includes('.3p-')
    || window.label.trim().toLowerCase().startsWith('claude/gpt ·');
}

function isExhausted(window: ProviderQuotaWindow): boolean {
  return window.limit > 0 && window.used >= window.limit;
}

/**
 * Resolve the ordered AGY model attempts for one automatic review.
 *
 * Only a configured Gemini model is rerouted, and only from a fresh successful
 * quota snapshot showing that at least one Gemini gate is exhausted. Sonnet is
 * the primary replacement. GPT-OSS is a bounded format/quality fallback unless
 * the shared Claude/GPT pool is already known to be exhausted.
 */
export function resolveAntigravityReviewModelPlan(
  configuredModel: string | undefined,
  snapshot: ProviderQuotaSnapshot | null,
  now = Date.now(),
): readonly (string | undefined)[] {
  if (!isGeminiModel(configuredModel) || !snapshot?.ok) return [configuredModel];

  const ageMs = now - snapshot.takenAt;
  if (ageMs < 0 || ageMs > MAX_QUOTA_SNAPSHOT_AGE_MS) return [configuredModel];

  const geminiWindows = snapshot.windows.filter(isGeminiWindow);
  if (geminiWindows.length === 0 || !geminiWindows.some(isExhausted)) return [configuredModel];

  const thirdPartyWindows = snapshot.windows.filter(isThirdPartyWindow);
  const sharedPoolExhausted = thirdPartyWindows.some(isExhausted);
  return sharedPoolExhausted
    ? [ANTIGRAVITY_REVIEW_FALLBACK_MODELS.SONNET]
    : [
        ANTIGRAVITY_REVIEW_FALLBACK_MODELS.SONNET,
        ANTIGRAVITY_REVIEW_FALLBACK_MODELS.GPT_OSS,
      ];
}
