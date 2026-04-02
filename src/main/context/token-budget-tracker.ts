/**
 * Token Budget Tracker - Monitors per-turn token usage and detects diminishing returns.
 * Inspired by Claude Code's BudgetTracker.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('TokenBudgetTracker');

const MIN_PRODUCTIVE_DELTA = 500;
const DIMINISHING_CHECK_THRESHOLD = 3;
const STOP_RATIO = 0.9;

export enum BudgetAction {
  CONTINUE = 'continue',
  STOP = 'stop',
}

export interface BudgetCheckResult {
  action: BudgetAction;
  reason?: string;
  nudgeMessage?: string;
  fillPercentage: number;
}

export interface TokenBudgetConfig {
  totalBudget: number;
}

export class TokenBudgetTracker {
  private config: TokenBudgetConfig;
  private continuationCount = 0;
  private deltas: number[] = [];

  constructor(config: TokenBudgetConfig) {
    this.config = config;
  }

  recordContinuation(deltaTokens: number): void {
    this.continuationCount++;
    this.deltas.push(deltaTokens);
  }

  checkBudget(params: { turnTokens: number }): BudgetCheckResult {
    const fillPercentage = Math.round((params.turnTokens / this.config.totalBudget) * 100);

    if (this.continuationCount >= DIMINISHING_CHECK_THRESHOLD) {
      const lastDelta = this.deltas[this.deltas.length - 1] ?? 0;
      if (lastDelta < MIN_PRODUCTIVE_DELTA) {
        logger.info('Diminishing returns detected', { continuationCount: this.continuationCount, lastDelta });
        return {
          action: BudgetAction.STOP,
          reason: `diminishing returns: last delta ${lastDelta} tokens after ${this.continuationCount} continuations`,
          fillPercentage,
        };
      }
    }

    if (params.turnTokens >= this.config.totalBudget * STOP_RATIO) {
      return { action: BudgetAction.STOP, reason: `budget ${fillPercentage}% full`, fillPercentage };
    }

    return {
      action: BudgetAction.CONTINUE,
      nudgeMessage: `Stopped at ${fillPercentage}% of token target (${params.turnTokens} / ${this.config.totalBudget}). Keep working — do not summarize.`,
      fillPercentage,
    };
  }

  reset(): void {
    this.continuationCount = 0;
    this.deltas = [];
  }

  getStats(): { continuations: number; totalDelta: number; lastDelta: number } {
    return {
      continuations: this.continuationCount,
      totalDelta: this.deltas.reduce((sum, d) => sum + d, 0),
      lastDelta: this.deltas[this.deltas.length - 1] ?? 0,
    };
  }
}
