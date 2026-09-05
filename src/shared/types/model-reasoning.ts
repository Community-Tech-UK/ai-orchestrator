import { getDefaultReasoningEffort, type ReasoningEffort } from './provider.types';

/** Capabilities from the model's runtime catalogue, refreshed with the model list. */
export interface ModelReasoningCapabilities {
  supportedEfforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}

/** Keep AIO's preferred effort only when this model advertises support for it. */
export function getModelDefaultReasoningEffort(
  provider: string,
  reasoning?: ModelReasoningCapabilities,
  model?: string | null,
): ReasoningEffort | null {
  const preferred = getDefaultReasoningEffort(provider, model);
  // Astra's app default is explicit even before its catalog capabilities load.
  if (!reasoning) return provider === 'codex' && model?.trim().toLowerCase() !== 'gpt-6-astra' ? null : preferred;
  if (preferred && reasoning.supportedEfforts.includes(preferred)) return preferred;
  const fallback = reasoning.defaultEffort;
  return fallback && reasoning.supportedEfforts.includes(fallback) ? fallback : null;
}
