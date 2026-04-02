/**
 * Output Token Escalator
 *
 * Implements Claude Code's max-output-tokens escalation strategy:
 * - Start with conservative default (8k)
 * - On first truncation: escalate to max (64k)
 * - On continued truncation: inject continuation messages (up to 3 attempts)
 * - On successful turn: reset recovery count
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('OutputTokenEscalator');

export interface EscalatorConfig {
  defaultTokens: number;
  maxTokens: number;
  maxRecoveryAttempts: number;
}

export interface EscalationResult {
  shouldRetry: boolean;
  newLimit?: number;
  attemptNumber?: number;
  alreadyEscalated?: boolean;
  exhausted?: boolean;
}

const DEFAULT_CONFIG: EscalatorConfig = {
  defaultTokens: 8192,
  maxTokens: 65536,
  maxRecoveryAttempts: 3,
};

export class OutputTokenEscalator {
  private config: EscalatorConfig;
  private currentLimit: number;
  private escalated = false;
  private recoveryCount = 0;

  constructor(config?: Partial<EscalatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentLimit = this.config.defaultTokens;
  }

  getCurrentLimit(): number {
    return this.currentLimit;
  }

  getRecoveryCount(): number {
    return this.recoveryCount;
  }

  /**
   * Called when output was truncated at current limit.
   * First call escalates to max; subsequent calls signal multi-turn recovery.
   */
  onTruncation(): EscalationResult {
    if (!this.escalated) {
      this.currentLimit = this.config.maxTokens;
      this.escalated = true;
      logger.info('Escalated output token limit', {
        from: this.config.defaultTokens,
        to: this.config.maxTokens,
      });
      return { shouldRetry: true, newLimit: this.config.maxTokens };
    }

    return { shouldRetry: false, alreadyEscalated: true };
  }

  /**
   * Called when output is truncated even at max limit.
   * Allows up to maxRecoveryAttempts continuation injections.
   */
  onMultiTurnTruncation(): EscalationResult {
    this.recoveryCount++;

    if (this.recoveryCount <= this.config.maxRecoveryAttempts) {
      logger.info('Multi-turn truncation recovery', {
        attempt: this.recoveryCount,
        maxAttempts: this.config.maxRecoveryAttempts,
      });
      return {
        shouldRetry: true,
        attemptNumber: this.recoveryCount,
      };
    }

    logger.warn('Multi-turn recovery exhausted', {
      attempts: this.recoveryCount,
    });
    return { shouldRetry: false, exhausted: true };
  }

  /**
   * Called after a successful (non-truncated) turn.
   * Resets recovery count but keeps escalated limit.
   */
  onSuccessfulTurn(): void {
    this.recoveryCount = 0;
  }

  /**
   * Full reset (e.g., on session restart).
   */
  reset(): void {
    this.currentLimit = this.config.defaultTokens;
    this.escalated = false;
    this.recoveryCount = 0;
  }
}
