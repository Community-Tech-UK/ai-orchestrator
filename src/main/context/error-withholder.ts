/**
 * Error Withholder
 *
 * Intercepts recoverable API errors and attempts layered recovery
 * BEFORE surfacing the error to the user. The error is "withheld"
 * during recovery attempts.
 *
 * Inspired by Claude Code's error withholding pattern in query.ts:
 * - prompt-too-long → context collapse → reactive compact → surface
 * - max-output-tokens → escalate → continuation injection → surface
 */

import { EventEmitter } from 'events';
import { OutputTokenEscalator } from './output-token-escalator';
import { getLogger } from '../logging/logger';

const logger = getLogger('ErrorWithholder');

export enum RecoveryOutcome {
  RECOVERED = 'recovered',
  FAILED = 'failed',
}

export interface RecoveryResult {
  outcome: RecoveryOutcome;
  stage: string;
  tokensSaved?: number;
  newOutputLimit?: number;
  continuationNeeded?: boolean;
}

export interface RecoveryStrategy {
  collapseRecovery: () => Promise<{ success: boolean; tokensSaved?: number }>;
  reactiveCompact: () => Promise<{ success: boolean; tokensSaved?: number }>;
}

export class ErrorWithholder extends EventEmitter {
  private strategies: RecoveryStrategy;
  private hasAttemptedReactiveCompact = false;
  private escalator = new OutputTokenEscalator();

  constructor(strategies: RecoveryStrategy) {
    super();
    this.strategies = strategies;
  }

  /**
   * Handle prompt-too-long (413) error.
   * Attempts recovery in order: collapse → reactive compact → fail.
   */
  async handlePromptTooLong(): Promise<RecoveryResult> {
    this.emit('error:withheld', { type: 'prompt_too_long' });

    // Stage 1: Context collapse recovery (cheapest)
    try {
      const collapseResult = await this.strategies.collapseRecovery();
      if (collapseResult.success) {
        logger.info('Recovered from prompt-too-long via context collapse', {
          tokensSaved: collapseResult.tokensSaved,
        });
        this.emit('recovery:succeeded', { stage: 'context_collapse' });
        return {
          outcome: RecoveryOutcome.RECOVERED,
          stage: 'context_collapse',
          tokensSaved: collapseResult.tokensSaved,
        };
      }
    } catch (err) {
      logger.warn('Context collapse recovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Stage 2: Reactive compact (one-shot guard)
    if (!this.hasAttemptedReactiveCompact) {
      this.hasAttemptedReactiveCompact = true;
      try {
        const compactResult = await this.strategies.reactiveCompact();
        if (compactResult.success) {
          logger.info('Recovered from prompt-too-long via reactive compact', {
            tokensSaved: compactResult.tokensSaved,
          });
          this.emit('recovery:succeeded', { stage: 'reactive_compact' });
          return {
            outcome: RecoveryOutcome.RECOVERED,
            stage: 'reactive_compact',
            tokensSaved: compactResult.tokensSaved,
          };
        }
      } catch (err) {
        logger.warn('Reactive compact recovery failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // All recovery exhausted
    logger.error('All prompt-too-long recovery strategies exhausted');
    this.emit('recovery:failed', { type: 'prompt_too_long' });
    return { outcome: RecoveryOutcome.FAILED, stage: 'exhausted' };
  }

  /**
   * Handle max-output-tokens truncation.
   * Attempts: escalation → continuation injection → fail.
   */
  async handleMaxOutputTokens(): Promise<RecoveryResult> {
    this.emit('error:withheld', { type: 'max_output_tokens' });

    // Try escalation first
    const escalation = this.escalator.onTruncation();
    if (escalation.shouldRetry && escalation.newLimit) {
      logger.info('Escalated max output tokens', { newLimit: escalation.newLimit });
      return {
        outcome: RecoveryOutcome.RECOVERED,
        stage: 'escalation',
        newOutputLimit: escalation.newLimit,
      };
    }

    // Already escalated — try multi-turn continuation
    const multiTurn = this.escalator.onMultiTurnTruncation();
    if (multiTurn.shouldRetry) {
      logger.info('Multi-turn continuation recovery', { attempt: multiTurn.attemptNumber });
      return {
        outcome: RecoveryOutcome.RECOVERED,
        stage: 'continuation',
        continuationNeeded: true,
      };
    }

    logger.error('Max output tokens recovery exhausted');
    this.emit('recovery:failed', { type: 'max_output_tokens' });
    return { outcome: RecoveryOutcome.FAILED, stage: 'exhausted' };
  }

  /**
   * Call after a successful (non-error) turn to reset recovery state.
   */
  onSuccessfulTurn(): void {
    this.escalator.onSuccessfulTurn();
  }

  /**
   * Full reset for new session.
   */
  reset(): void {
    this.hasAttemptedReactiveCompact = false;
    this.escalator.reset();
  }
}
