import type { LoopState } from '../../shared/types/loop.types';

export interface LoopReviewBudgetExceeded { status: 'cost-exceeded' | 'cap-reached'; reason: string }
/** Review is paid work: completion cannot bypass a cap it just exhausted. */
export function reviewBudgetExceeded(state: LoopState): LoopReviewBudgetExceeded | null {
  const caps = state.config.caps;
  if (caps.maxCostCents !== null && state.totalCostCents >= caps.maxCostCents) {
    return { status: 'cost-exceeded', reason: `The second-opinion review brought this run to its spending limit ($${(caps.maxCostCents / 100).toFixed(2)}).` };
  }
  if (caps.maxTokens !== null && state.totalTokens >= caps.maxTokens) {
    return { status: 'cap-reached', reason: 'The second-opinion review brought this run to its token limit before completion could be accepted.' };
  }
  return null;
}
