/**
 * Shared task-routing helper (intent-routing Phase 1).
 *
 * Extracts the provider-aware model-resolution logic that previously lived only
 * inside `instance-orchestration.routeChildModel`, so the child/agent-spawn path
 * AND other callers (e.g. Loop Mode via `default-invokers`) share ONE routing
 * implementation instead of each re-deriving model selection.
 *
 * Design constraints (see bigchange_intent_routing_plan):
 *   - Reuse the existing `ModelRouter` / `RoutingDecision` — no parallel taxonomy.
 *   - `applyProviderResolution` is the pure cross-provider mapping, extracted
 *     verbatim from `routeChildModel` so that path stays behavior-preserving.
 *   - `resolveRoutedModel` is dependency-light: model router + agent override +
 *     cross-provider mapping. It deliberately does NOT consult outcome-learning
 *     or the preference store — those legs are child-spawn-specific and remain in
 *     `instance-orchestration.computeRoutingDecision`.
 */

import { getLogger } from '../logging/logger';
import { getModelRouter, type RoutingDecision } from './model-router';
import {
  isModelTier,
  normalizeModelAliasForProvider,
  resolveModelForTier,
} from '../../shared/types/provider.types';
import { getAgentById } from '../../shared/types/agent.types';

const logger = getLogger('RouteTask');

export interface ResolveRoutedModelOptions {
  /** An explicit model id or tier name requested by the caller. */
  explicitModel?: string;
  /** Agent whose `modelOverride` (if any) should win. */
  agentId?: string;
  /** Target provider namespace; `undefined`/`auto`/`claude` keep Claude-centric ids. */
  provider?: string;
}

/**
 * Apply provider-aware resolution to an already-computed base decision.
 *
 * When the target provider is non-claude/non-auto, map the decision's tier to
 * that provider's concrete model id (or honor an explicit concrete model). For
 * claude/auto/undefined providers the decision passes through unchanged.
 *
 * Extracted verbatim from `instance-orchestration.routeChildModel` so both the
 * spawn path and the Loop-Mode invoker share one implementation.
 */
export function applyProviderResolution(
  decision: RoutingDecision,
  normalizedExplicitModel: string | undefined,
  provider: string | undefined,
): RoutingDecision {
  const hasExplicitConcreteModel = Boolean(
    normalizedExplicitModel && !isModelTier(normalizedExplicitModel),
  );

  // If the target is a non-Claude provider, resolve the decision's tier to that
  // provider's concrete model ID. Handles explicit tier names and auto-routed
  // Claude model IDs that need cross-provider mapping.
  if (provider && provider !== 'auto' && provider !== 'claude') {
    if (hasExplicitConcreteModel) {
      return {
        ...decision,
        model: normalizedExplicitModel!,
        reason: `${decision.reason} for ${provider}`,
      };
    }

    const resolvedId = resolveModelForTier(decision.tier, provider);
    if (resolvedId) {
      logger.info('Resolved model for target provider', {
        originalModel: decision.model,
        tier: decision.tier,
        provider,
        resolvedModel: resolvedId,
      });
      return {
        ...decision,
        model: resolvedId,
        reason: `${decision.reason} → resolved to "${resolvedId}" for ${provider}`,
      };
    }

    // No model found for this tier+provider — let lifecycle validation handle it.
    logger.warn('No model found for tier in target provider, passing through', {
      tier: decision.tier,
      provider,
      originalModel: decision.model,
    });
  }

  return decision;
}

/**
 * Compute a base routing decision for a task WITHOUT the instance-specific
 * outcome-learning / preference-store legs.
 *
 * Covers, in precedence order: explicit concrete model, explicit tier name,
 * agent override, then auto-route by task-complexity analysis.
 */
function computeBaseDecision(
  task: string,
  normalizedExplicitModel: string | undefined,
  agentId: string | undefined,
): RoutingDecision {
  const router = getModelRouter();

  // Explicit concrete model → pass straight to the router.
  if (normalizedExplicitModel && !isModelTier(normalizedExplicitModel)) {
    return router.route(task, normalizedExplicitModel);
  }

  // Explicit tier name → complexity is pre-determined.
  if (normalizedExplicitModel && isModelTier(normalizedExplicitModel)) {
    return {
      model:
        normalizedExplicitModel === 'powerful'
          ? 'opus'
          : normalizedExplicitModel === 'fast'
            ? 'haiku'
            : 'sonnet',
      complexity:
        normalizedExplicitModel === 'powerful'
          ? 'complex'
          : normalizedExplicitModel === 'fast'
            ? 'simple'
            : 'moderate',
      tier: normalizedExplicitModel,
      confidence: 1.0,
      reason: `Explicit tier "${normalizedExplicitModel}" requested`,
    };
  }

  // Agent override.
  if (agentId) {
    const agent = getAgentById(agentId);
    if (agent?.modelOverride) {
      return {
        model: agent.modelOverride,
        complexity: 'simple',
        tier: router.getModelTier(agent.modelOverride),
        confidence: 1.0,
        reason: `Agent "${agent.name}" has model override configured`,
      };
    }
  }

  // Auto-route based on task-complexity analysis.
  return router.route(task);
}

/**
 * Provider-aware routing for callers OUTSIDE `instance-orchestration`
 * (e.g. Loop Mode). Dependency-light: model router + agent override +
 * cross-provider mapping. Does NOT consult outcome-learning or the preference
 * store (those remain in the child-spawn path's `computeRoutingDecision`).
 */
export function resolveRoutedModel(
  task: string,
  options: ResolveRoutedModelOptions = {},
): RoutingDecision {
  const providerForModel =
    options.provider && options.provider !== 'auto' ? options.provider : undefined;
  const normalizedExplicitModel = providerForModel
    ? normalizeModelAliasForProvider(providerForModel, options.explicitModel)
    : options.explicitModel;
  const decision = computeBaseDecision(task, normalizedExplicitModel, options.agentId);
  return applyProviderResolution(decision, normalizedExplicitModel, options.provider);
}
