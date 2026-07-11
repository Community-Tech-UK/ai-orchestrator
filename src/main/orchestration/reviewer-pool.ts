import { getLogger } from '../logging/logger';

const logger = getLogger('ReviewerPool');

const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const REVIEWER_FAILURE_COOLDOWN_MS = 5 * 60_000;

export interface ReviewerInfo {
  cliType: string;
  available: boolean;
  lastUsed: number;
  consecutiveFailures: number;
  rateLimited: boolean;
  rateLimitResetAt: number;
  unavailableUntil: number;
  totalReviewsCompleted: number;
}

export class ReviewerPool {
  private reviewers = new Map<string, ReviewerInfo>();

  setAvailable(cliTypes: string[]): void {
    const now = Date.now();
    const known = new Set(this.reviewers.keys());
    for (const cliType of cliTypes) {
      if (!known.has(cliType)) {
        this.reviewers.set(cliType, {
          cliType,
          available: true,
          lastUsed: 0,
          consecutiveFailures: 0,
          rateLimited: false,
          rateLimitResetAt: 0,
          unavailableUntil: 0,
          totalReviewsCompleted: 0,
        });
      } else {
        const existing = this.reviewers.get(cliType)!;
        if (!existing.available && now >= existing.unavailableUntil) {
          existing.available = true;
          existing.consecutiveFailures = 0;
          existing.unavailableUntil = 0;
        }
      }
    }
    for (const [key, info] of this.reviewers) {
      if (!cliTypes.includes(key)) {
        info.available = false;
      }
    }
  }

  /**
   * Pick up to `maxReviewers` reviewers for a check.
   *
   * When `preferredOrder` is supplied (the user's configured reviewer list),
   * selection is deterministic: reviewers are taken strictly in that order, so
   * the first N available providers run each check and the remainder act as
   * ordered fallbacks. Providers not in `preferredOrder` (and the auto-detect
   * case where it's empty) fall back to least-recently-used rotation, which
   * keeps load spread across an unordered pool.
   */
  selectReviewers(
    primaryProvider: string,
    maxReviewers: number,
    excludeCliTypes: readonly string[] = [],
    preferredOrder: readonly string[] = [],
  ): string[] {
    const excluded = new Set(excludeCliTypes);
    const orderRank = new Map<string, number>();
    preferredOrder.forEach((cliType, index) => {
      if (!orderRank.has(cliType)) orderRank.set(cliType, index);
    });
    const rankOf = (cliType: string): number => orderRank.get(cliType) ?? Number.MAX_SAFE_INTEGER;

    const candidates = Array.from(this.reviewers.values())
      .filter(r => r.available && !r.rateLimited && r.cliType !== primaryProvider && !excluded.has(r.cliType))
      .sort((a, b) => {
        const rankDelta = rankOf(a.cliType) - rankOf(b.cliType);
        // Configured order wins; LRU only breaks ties (or drives the auto pool).
        return rankDelta !== 0 ? rankDelta : a.lastUsed - b.lastUsed;
      });

    const selected = candidates.slice(0, maxReviewers).map(r => r.cliType);

    const now = Date.now();
    for (const cliType of selected) {
      const reviewer = this.reviewers.get(cliType);
      if (reviewer) reviewer.lastUsed = now;
    }

    return selected;
  }

  recordSuccess(cliType: string): void {
    const reviewer = this.reviewers.get(cliType);
    if (!reviewer) return;
    reviewer.consecutiveFailures = 0;
    reviewer.totalReviewsCompleted++;
    reviewer.available = true;
    reviewer.unavailableUntil = 0;
  }

  recordFailure(cliType: string): void {
    const reviewer = this.reviewers.get(cliType);
    if (!reviewer) return;
    reviewer.consecutiveFailures++;
    if (reviewer.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      reviewer.available = false;
      reviewer.unavailableUntil = Date.now() + REVIEWER_FAILURE_COOLDOWN_MS;
      logger.warn('Reviewer marked unavailable after consecutive failures', {
        cliType,
        failures: reviewer.consecutiveFailures,
        unavailableUntil: reviewer.unavailableUntil,
      });
    }
  }

  markRateLimited(cliType: string, cooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS): void {
    const reviewer = this.reviewers.get(cliType);
    if (!reviewer) return;
    reviewer.rateLimited = true;
    reviewer.rateLimitResetAt = Date.now() + cooldownMs;
    logger.info('Reviewer rate-limited', { cliType, cooldownMs });
  }

  /** @returns the cliTypes whose rate limit was cleared this tick (for surfacing). */
  checkRateLimitRecovery(): string[] {
    const now = Date.now();
    const cleared: string[] = [];
    for (const reviewer of this.reviewers.values()) {
      if (reviewer.rateLimited && now >= reviewer.rateLimitResetAt) {
        reviewer.rateLimited = false;
        cleared.push(reviewer.cliType);
        logger.info('Reviewer rate limit cleared', { cliType: reviewer.cliType });
      }
    }
    return cleared;
  }

  checkAvailabilityRecovery(): void {
    const now = Date.now();
    for (const reviewer of this.reviewers.values()) {
      if (!reviewer.available && reviewer.unavailableUntil > 0 && now >= reviewer.unavailableUntil) {
        reviewer.consecutiveFailures = 0;
        reviewer.unavailableUntil = 0;
        logger.info('Reviewer failure cooldown expired', { cliType: reviewer.cliType });
      }
    }
  }

  getStatus(): { cliType: string; available: boolean; rateLimited: boolean; totalReviews: number }[] {
    return Array.from(this.reviewers.values()).map(r => ({
      cliType: r.cliType,
      available: r.available,
      rateLimited: r.rateLimited,
      totalReviews: r.totalReviewsCompleted,
    }));
  }

  hasAvailableReviewers(primaryProvider: string): boolean {
    return Array.from(this.reviewers.values()).some(r =>
      r.available && !r.rateLimited && r.cliType !== primaryProvider
    );
  }
}
