import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewerPool } from './reviewer-pool';

afterEach(() => vi.useRealTimers());
describe('invalid review retirement', () => {
  it('keeps two invalid operations retired through successes and refreshes until the next local day', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 31, 12));
    const pool = new ReviewerPool(); pool.setAvailable(['codex', 'gemini']);
    pool.recordValidationFailure('codex');
    expect(pool.selectReviewers('claude', 2)).toContain('codex');
    pool.recordValidationFailure('codex'); pool.recordSuccess('codex'); pool.setAvailable(['codex', 'gemini']);
    vi.advanceTimersByTime(6 * 60 * 60_000); pool.checkAvailabilityRecovery();
    expect(pool.selectReviewers('claude', 2)).toEqual(['gemini']);
    vi.setSystemTime(new Date(2026, 10, 1, 0, 1)); pool.setAvailable(['codex', 'gemini']);
    expect(pool.selectReviewers('claude', 2)).toContain('codex');
  });

  it('remembers invalid pinned reviewers even when discovery never added them to the pool', () => {
    const pool = new ReviewerPool();
    pool.recordValidationFailure('copilot'); pool.recordValidationFailure('copilot');
    pool.setAvailable(['copilot']);
    expect(pool.selectReviewers('claude', 1)).toEqual([]);
    expect(pool.isValidationRetired('copilot')).toBe(true);
  });
});
