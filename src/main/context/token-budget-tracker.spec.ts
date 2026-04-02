import { describe, it, expect, beforeEach } from 'vitest';
import { TokenBudgetTracker, BudgetAction } from './token-budget-tracker';

describe('TokenBudgetTracker', () => {
  let tracker: TokenBudgetTracker;

  beforeEach(() => {
    tracker = new TokenBudgetTracker({ totalBudget: 10000 });
  });

  it('allows continuation when under 90% of budget', () => {
    const result = tracker.checkBudget({ turnTokens: 5000 });
    expect(result.action).toBe(BudgetAction.CONTINUE);
    expect(result.nudgeMessage).toContain('Keep working');
  });

  it('stops when over 90% of budget', () => {
    const result = tracker.checkBudget({ turnTokens: 9500 });
    expect(result.action).toBe(BudgetAction.STOP);
  });

  it('detects diminishing returns after 3+ continuations', () => {
    tracker.recordContinuation(2000);
    tracker.recordContinuation(1000);
    tracker.recordContinuation(400);
    tracker.recordContinuation(200);
    const result = tracker.checkBudget({ turnTokens: 3600 });
    expect(result.action).toBe(BudgetAction.STOP);
    expect(result.reason).toContain('diminishing');
  });

  it('does not detect diminishing returns with < 3 continuations', () => {
    tracker.recordContinuation(2000);
    tracker.recordContinuation(200);
    const result = tracker.checkBudget({ turnTokens: 2200 });
    expect(result.action).toBe(BudgetAction.CONTINUE);
  });

  it('resets state correctly', () => {
    tracker.recordContinuation(5000);
    tracker.recordContinuation(300);
    tracker.recordContinuation(100);
    tracker.recordContinuation(50);
    tracker.reset();
    const result = tracker.checkBudget({ turnTokens: 3000 });
    expect(result.action).toBe(BudgetAction.CONTINUE);
  });

  it('provides accurate fill percentage', () => {
    const result = tracker.checkBudget({ turnTokens: 5000 });
    expect(result.nudgeMessage).toContain('50%');
  });
});
