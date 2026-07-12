/**
 * Iteration cost resolution for Loop Mode.
 *
 * Loop spend is ~97% of measured AIO cost, so how an iteration is priced is not
 * a detail. The legacy path multiplied `tokens` by a flat $15/Mtok
 * (`COST_PER_M_TOKENS_CENTS`) whenever the provider reported no dollar figure.
 * That token total *includes cache reads*, which bill at ~10% of the input
 * rate — so the cheapest tokens in the mix were priced at the most expensive
 * rate. Against the measured blended rate (~$5.45/Mtok) it overstated real loop
 * spend by roughly 2.75x, and every prioritisation decision downstream of the
 * spend dashboard inherited that error.
 *
 * Precedence:
 *   1. Provider-reported dollars — authoritative, already reflects the
 *      provider's exact cache accounting.
 *   2. `computeTokenCost` over the usage breakdown, per model — the same
 *      single source of truth the CostTracker uses.
 *   3. The legacy flat estimate — only when the adapter reported no usage at
 *      all, so there is genuinely nothing better to go on.
 */
import { computeTokenCost } from '../../shared/data/model-pricing';
import { COST_PER_M_TOKENS_CENTS, type LoopChildResult } from './loop-coordinator.types';

export type IterationCostBasis =
  /** Provider reported a dollar cost (e.g. Claude `total_cost_usd`). */
  | 'provider-reported'
  /** Derived per-model from the usage breakdown via `computeTokenCost`. */
  | 'computed'
  /** Legacy flat $15/Mtok. No usage breakdown was available. */
  | 'legacy-estimate';

export interface IterationCost {
  costCents: number;
  basis: IterationCostBasis;
  /** True only for `provider-reported`. Persisted so audits can filter estimates out. */
  costKnown: boolean;
}

/** A usage record is only useful if it carries at least one positive count. */
function hasUsageBreakdown(usage: LoopChildResult['usage']): boolean {
  if (!usage) return false;
  return Object.values(usage).some(
    (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
  );
}

export function resolveIterationCost(
  result: Pick<LoopChildResult, 'tokens' | 'costUsd' | 'usage' | 'model'>,
): IterationCost {
  if (typeof result.costUsd === 'number' && Number.isFinite(result.costUsd)) {
    return {
      costCents: Math.max(0, Math.ceil(result.costUsd * 100)),
      basis: 'provider-reported',
      costKnown: true,
    };
  }

  if (hasUsageBreakdown(result.usage)) {
    return {
      costCents: Math.max(0, Math.ceil(computeTokenCost(result.model, result.usage!) * 100)),
      basis: 'computed',
      costKnown: false,
    };
  }

  const tokens = Math.max(0, result.tokens || 0);
  return {
    costCents: Math.ceil((tokens / 1_000_000) * COST_PER_M_TOKENS_CENTS),
    basis: 'legacy-estimate',
    costKnown: false,
  };
}
