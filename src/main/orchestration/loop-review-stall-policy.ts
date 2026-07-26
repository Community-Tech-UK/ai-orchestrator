export interface ReviewStallPolicyInput {
  critical: boolean;
  productionChangesObserved: boolean;
  ledgerMeaningfulTransition: boolean;
  cleanReviewConvergenceActive: boolean;
  consecutiveStallCount: number;
  limit: number;
  capWrapUpActive: boolean;
}

export type ReviewStallPolicyDecision = {
  action: 'reset' | 'increment' | 'suppress' | 'terminalize';
  nextCount: number;
  reason:
    | 'production-progress'
    | 'ledger-progress'
    | 'clean-review-progress'
    | 'not-critical'
    | 'critical-no-progress'
    | 'critical-no-progress-limit'
    | 'cap-wrap-up-precedence';
};

export function evaluateReviewStall(input: ReviewStallPolicyInput): ReviewStallPolicyDecision {
  if (input.productionChangesObserved) {
    return { action: 'reset', nextCount: 0, reason: 'production-progress' };
  }
  if (input.ledgerMeaningfulTransition) {
    return { action: 'reset', nextCount: 0, reason: 'ledger-progress' };
  }
  if (input.cleanReviewConvergenceActive) {
    return { action: 'reset', nextCount: 0, reason: 'clean-review-progress' };
  }
  if (!input.critical) {
    return { action: 'reset', nextCount: 0, reason: 'not-critical' };
  }

  const nextCount = input.consecutiveStallCount + 1;
  if (input.capWrapUpActive) {
    return { action: 'suppress', nextCount, reason: 'cap-wrap-up-precedence' };
  }
  if (nextCount >= Math.max(1, input.limit)) {
    return { action: 'terminalize', nextCount, reason: 'critical-no-progress-limit' };
  }
  return { action: 'increment', nextCount, reason: 'critical-no-progress' };
}
