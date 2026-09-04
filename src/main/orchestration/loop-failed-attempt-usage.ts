import type { LoopState } from '../../shared/types/loop.types';
import type { LoopChildInvocationError, LoopChildUsage } from './loop-coordinator.types';
import { resolveIterationCost } from './loop-iteration-cost';

export interface FailedAttemptUsageCharge {
  tokens: number;
  costCents: number;
  model?: string;
  estimated: boolean;
}

/**
 * Fold sanitized partial usage from one failed provider attempt into run-level
 * spend. The failed turn is not an iteration, but it still consumed provider
 * work and must count toward budget safeguards.
 */
export function chargeFailedAttemptUsage(
  state: LoopState,
  error: unknown,
): FailedAttemptUsageCharge | null {
  const shaped = error as Pick<LoopChildInvocationError, 'model' | 'partialUsage'> | null | undefined;
  const usage = shaped?.partialUsage;
  const tokens = totalTokens(usage);
  if (tokens <= 0) return null;

  // Only hand `usage` to the pricer when it carries a field the pricer can
  // actually price. `resolveIterationCost` picks its `computed` basis from
  // "any positive number in the usage object", but `computeTokenCost` reads
  // only the input/output/cache/reasoning breakdown — so a totals-only snapshot
  // would price a real token charge at $0.00. Withholding it falls back to the
  // legacy flat estimate, which is rough but not zero.
  const { costCents } = resolveIterationCost({
    tokens,
    ...(hasPricedTokens(usage) ? { usage } : {}),
    model: shaped?.model,
  });
  state.totalTokens += tokens;
  state.totalCostCents += costCents;
  state.tokensSinceLastTestImprovement += tokens;
  return {
    tokens,
    costCents,
    ...(shaped?.model ? { model: shaped.model } : {}),
    estimated: usage?.isEstimated === true,
  };
}

/** True when the usage carries at least one field `computeTokenCost` prices. */
function hasPricedTokens(usage: LoopChildUsage | undefined): boolean {
  if (!usage) return false;
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens,
  ].some((count) => typeof count === 'number' && count > 0);
}

function totalTokens(usage: LoopChildUsage | undefined): number {
  if (!usage) return 0;
  if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
    return Math.max(0, Math.floor(usage.totalTokens));
  }
  return Math.max(0, Math.floor(
    (usage.inputTokens ?? 0)
    + (usage.outputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + (usage.reasoningTokens ?? 0),
  ));
}
