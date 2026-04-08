import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReviewerPool } from './reviewer-pool';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('ReviewerPool', () => {
  let pool: ReviewerPool;
  let now: number;

  beforeEach(() => {
    now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    pool = new ReviewerPool();
    pool.setAvailable(['gemini', 'codex', 'copilot']);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('selectReviewers', () => {
    it('selects up to maxReviewers excluding primary provider', () => {
      const selected = pool.selectReviewers('claude', 2);
      expect(selected).toHaveLength(2);
      expect(selected).not.toContain('claude');
    });

    it('round-robins across selections', () => {
      const first = pool.selectReviewers('claude', 2);
      const second = pool.selectReviewers('claude', 2);
      expect(first[0]).not.toBe(second[0]);
    });

    it('returns fewer if not enough reviewers available', () => {
      pool.setAvailable(['gemini']);
      const selected = pool.selectReviewers('claude', 2);
      expect(selected).toHaveLength(1);
    });

    it('returns empty array if no reviewers available', () => {
      pool.setAvailable([]);
      const selected = pool.selectReviewers('claude', 2);
      expect(selected).toHaveLength(0);
    });

    it('excludes rate-limited reviewers', () => {
      pool.markRateLimited('gemini');
      const selected = pool.selectReviewers('claude', 3);
      expect(selected).not.toContain('gemini');
    });

    it('excludes the primary provider', () => {
      const selected = pool.selectReviewers('gemini', 3);
      expect(selected).not.toContain('gemini');
    });

    it('excludes reviewers already attempted for the current review', () => {
      const selected = pool.selectReviewers('claude', 3, ['gemini', 'codex']);
      expect(selected).toEqual(['copilot']);
    });
  });

  describe('failover', () => {
    it('marks reviewer unavailable after 3 consecutive failures', () => {
      pool.recordFailure('gemini');
      pool.recordFailure('gemini');
      pool.recordFailure('gemini');
      const selected = pool.selectReviewers('claude', 3);
      expect(selected).not.toContain('gemini');
    });

    it('resets failure count on success', () => {
      pool.recordFailure('gemini');
      pool.recordFailure('gemini');
      pool.recordSuccess('gemini');
      pool.recordFailure('gemini');
      const selected = pool.selectReviewers('claude', 3);
      expect(selected).toContain('gemini');
    });

    it('keeps failed reviewers out of rotation until the cooldown expires', () => {
      pool.recordFailure('gemini');
      pool.recordFailure('gemini');
      pool.recordFailure('gemini');

      pool.setAvailable(['gemini', 'codex', 'copilot']);
      expect(pool.selectReviewers('claude', 3)).not.toContain('gemini');

      vi.setSystemTime(now + 5 * 60_000 + 1);
      pool.setAvailable(['gemini', 'codex', 'copilot']);
      expect(pool.selectReviewers('claude', 3)).toContain('gemini');
    });
  });

  describe('rate limit recovery', () => {
    it('recovers rate-limited reviewer after cooldown', () => {
      pool.markRateLimited('gemini', 0);
      pool.checkRateLimitRecovery();
      const selected = pool.selectReviewers('claude', 3);
      expect(selected).toContain('gemini');
    });
  });

  describe('availability recovery', () => {
    it('only restores failed reviewers after the next availability refresh', () => {
      pool.recordFailure('gemini');
      pool.recordFailure('gemini');
      pool.recordFailure('gemini');

      vi.setSystemTime(now + 5 * 60_000 + 1);
      pool.checkAvailabilityRecovery();
      expect(pool.selectReviewers('claude', 3)).not.toContain('gemini');

      pool.setAvailable(['gemini', 'codex', 'copilot']);

      expect(pool.selectReviewers('claude', 3)).toContain('gemini');
    });
  });

  describe('getStatus', () => {
    it('returns status of all reviewers', () => {
      const status = pool.getStatus();
      expect(status).toHaveLength(3);
      expect(status.every(r => r.available)).toBe(true);
    });
  });

  describe('hasAvailableReviewers', () => {
    it('returns true when reviewers are available', () => {
      expect(pool.hasAvailableReviewers('claude')).toBe(true);
    });

    it('returns false when all are rate-limited', () => {
      pool.markRateLimited('gemini');
      pool.markRateLimited('codex');
      pool.markRateLimited('copilot');
      expect(pool.hasAvailableReviewers('claude')).toBe(false);
    });
  });
});
