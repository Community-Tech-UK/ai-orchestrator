/**
 * Resolve the initial model for a spawning instance (A8a).
 *
 * Precedence (highest first):
 *   1. explicit config override   — the model the caller asked for (also how the
 *      model-router delivers its decision for child instances)
 *   2. agent override             — a model pinned by the resolved agent
 *   3. per-provider remembered    — AppSettings.defaultModelByProvider[provider],
 *      which the renderer persists as the user's last-used model per provider
 *      (see renderer provider-state.service.ts). Honoring it here makes a backend
 *      spawn start on the same model the picker would pre-select.
 *   4. global default             — the legacy AppSettings.defaultModel fallback
 *
 * Returns `undefined` only when no source supplies a model, in which case the
 * caller lets the provider fall back to its own built-in default. The result is
 * still subject to the caller's provider-validation (tier resolution + drop of
 * models unknown to the target provider), so a stale remembered model degrades
 * safely to the provider default.
 */
export function resolveInitialModel(params: {
  configModelOverride?: string | null;
  agentModelOverride?: string | null;
  provider: string;
  defaultModelByProvider?: Record<string, string>;
  defaultModel?: string;
}): string | undefined {
  const perProvider = params.provider
    ? params.defaultModelByProvider?.[params.provider]
    : undefined;
  return (
    params.configModelOverride ||
    params.agentModelOverride ||
    perProvider ||
    params.defaultModel ||
    undefined
  );
}
