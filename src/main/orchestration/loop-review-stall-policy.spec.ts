import { describe, expect, it } from 'vitest';
import { evaluateReviewStall } from './loop-review-stall-policy';

describe('evaluateReviewStall', () => {
  it.each([
    ['production-progress', { productionChangesObserved: true }],
    ['ledger-progress', { ledgerMeaningfulTransition: true }],
    ['clean-review-progress', { cleanReviewConvergenceActive: true }],
  ] as const)('resets on %s', (reason, override) => {
    expect(evaluateReviewStall({
      critical: true,
      productionChangesObserved: false,
      ledgerMeaningfulTransition: false,
      cleanReviewConvergenceActive: false,
      consecutiveStallCount: 2,
      limit: 3,
      capWrapUpActive: false,
      ...override,
    })).toEqual({ action: 'reset', nextCount: 0, reason });
  });

  it('terminalizes the third unchanged CRITICAL iteration', () => {
    expect(evaluateReviewStall({
      critical: true,
      productionChangesObserved: false,
      ledgerMeaningfulTransition: false,
      cleanReviewConvergenceActive: false,
      consecutiveStallCount: 2,
      limit: 3,
      capWrapUpActive: false,
    })).toEqual({ action: 'terminalize', nextCount: 3, reason: 'critical-no-progress-limit' });
  });

  it('records secondary stall evidence without overriding an active cap', () => {
    expect(evaluateReviewStall({
      critical: true,
      productionChangesObserved: false,
      ledgerMeaningfulTransition: false,
      cleanReviewConvergenceActive: false,
      consecutiveStallCount: 2,
      limit: 3,
      capWrapUpActive: true,
    })).toEqual({ action: 'suppress', nextCount: 3, reason: 'cap-wrap-up-precedence' });
  });
});
