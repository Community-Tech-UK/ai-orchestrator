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

  selectReviewers(primaryProvider: string, maxReviewers: number, excludeCliTypes: readonly string[] = []): string[] {
    const excluded = new Set(excludeCliTypes);
    const candidates = Array.from(this.reviewers.values())
      .filter(r => r.available && !r.rateLimited && r.cliType !== primaryProvider && !excluded.has(r.cliType))
      .sort((a, b) => a.lastUsed - b.lastUsed);

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

  checkRateLimitRecovery(): void {
    const now = Date.now();
    for (const reviewer of this.reviewers.values()) {
      if (reviewer.rateLimited && now >= reviewer.rateLimitResetAt) {
        reviewer.rateLimited = false;
        logger.info('Reviewer rate limit cleared', { cliType: reviewer.cliType });
      }
    }
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
