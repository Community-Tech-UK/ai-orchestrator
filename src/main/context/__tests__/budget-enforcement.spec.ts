import { describe, it, expect, beforeEach } from 'vitest';
import { TokenBudgetTracker, BudgetAction } from '../token-budget-tracker.js';

describe('TokenBudgetTracker enforcement behavior', () => {
  let tracker: TokenBudgetTracker;

  beforeEach(() => {
    tracker = new TokenBudgetTracker({ totalBudget: 10000 });
  });

  it('should return CONTINUE when under budget', () => {
    const result = tracker.checkBudget({ turnTokens: 5000 });
    expect(result.action).toBe(BudgetAction.CONTINUE);
  });

  it('should return STOP when turn tokens exceed 90% of budget', () => {
    const result = tracker.checkBudget({ turnTokens: 9500 });
    expect(result.action).toBe(BudgetAction.STOP);
    expect(result.reason).toBeDefined();
  });

  it('should return STOP on diminishing returns after 3+ continuations', () => {
    tracker.recordContinuation(1000);
    tracker.recordContinuation(800);
    tracker.recordContinuation(200); // delta < 500 after 3 continuations
    const result = tracker.checkBudget({ turnTokens: 3000 });
    expect(result.action).toBe(BudgetAction.STOP);
    expect(result.reason).toContain('diminishing');
  });
});
