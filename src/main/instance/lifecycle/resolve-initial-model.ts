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
export interface InitialModelParams {
  configModelOverride?: string | null;
  agentModelOverride?: string | null;
  provider: string;
  defaultModelByProvider?: Record<string, string>;
  defaultModel?: string;
}

/**
 * Which rung of the precedence chain supplied the model (LT-016).
 *
 * `global-default` is the one that matters: `AppSettings.defaultModel` is
 * provider-agnostic (typically a Claude id), so it gets offered to every
 * provider and correctly rejected by most. A rejection traced to it is not a
 * user selection going stale, and must not be reported as one.
 */
export type InitialModelSource =
  | 'requested'
  | 'agent'
  | 'remembered'
  | 'global-default'
  | 'none';

export interface InitialModelResolution {
  model: string | undefined;
  source: InitialModelSource;
}

/**
 * Resolve the model **and** say where it came from, in one pass.
 *
 * Deliberately the only implementation of this precedence. An earlier version
 * of the LT-016 fix recomputed provenance beside the decision, which meant a
 * future reordering of one could silently disagree with the other and make the
 * suppression lie.
 */
export function resolveInitialModelWithSource(params: InitialModelParams): InitialModelResolution {
  if (params.configModelOverride) return { model: params.configModelOverride, source: 'requested' };
  if (params.agentModelOverride) return { model: params.agentModelOverride, source: 'agent' };
  const perProvider = params.provider
    ? params.defaultModelByProvider?.[params.provider]
    : undefined;
  if (perProvider) return { model: perProvider, source: 'remembered' };
  if (params.defaultModel) return { model: params.defaultModel, source: 'global-default' };
  return { model: undefined, source: 'none' };
}

export function resolveInitialModel(params: InitialModelParams): string | undefined {
  return resolveInitialModelWithSource(params).model;
}
