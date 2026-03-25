/**
 * Context Window Guard
 *
 * Validates that a model has sufficient context window capacity before starting
 * work, inspired by openclaw's context-guard pattern. Pure utility module — no
 * class, no singleton, just exported functions and types.
 */

import { getLogger } from '../logging/logger';
import { LIMITS } from '../../shared/constants/limits';

const logger = getLogger('ContextWindowGuard');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Warn if remaining context window capacity falls below this many tokens. */
export const CONTEXT_WINDOW_WARN_BELOW = 32000;

/** Block if remaining context window capacity falls below this many tokens. */
export const CONTEXT_WINDOW_HARD_MIN = 16000;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ContextWindowInfo {
  /** Resolved context window size in tokens. */
  tokens: number;
  /** How the value was determined. */
  source: 'config' | 'model' | 'default';
}

export interface ContextWindowGuardResult {
  /** Whether the operation is permitted to proceed. */
  allowed: boolean;
  /** Whether a low-context warning should be surfaced to the user. */
  shouldWarn: boolean;
  /** Tokens remaining in the context window. */
  remainingTokens: number;
  /** How the context window size was resolved. */
  source: ContextWindowInfo['source'];
  /** Human-readable message when the guard warns or blocks. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Resolve the effective context window size from the available sources.
 *
 * Priority: configOverride > modelContextWindow > defaultTokens > 200 000.
 */
export function resolveContextWindowSize(options: {
  configOverride?: number;
  modelContextWindow?: number;
  defaultTokens?: number;
}): ContextWindowInfo {
  const { configOverride, modelContextWindow, defaultTokens } = options;

  if (configOverride !== undefined && configOverride > 0) {
    logger.debug('Context window resolved from config override', { tokens: configOverride });
    return { tokens: configOverride, source: 'config' };
  }

  if (modelContextWindow !== undefined && modelContextWindow > 0) {
    logger.debug('Context window resolved from model metadata', { tokens: modelContextWindow });
    return { tokens: modelContextWindow, source: 'model' };
  }

  const fallback = (defaultTokens !== undefined && defaultTokens > 0) ? defaultTokens : LIMITS.DEFAULT_MAX_CONTEXT_TOKENS;
  logger.debug('Context window resolved from default', { tokens: fallback });
  return { tokens: fallback, source: 'default' };
}

/**
 * Evaluate whether the remaining context window is sufficient to proceed.
 *
 * - `shouldWarn` is true when remaining tokens are positive but below
 *   `CONTEXT_WINDOW_WARN_BELOW`.
 * - `allowed` is false when remaining tokens are positive but below
 *   `CONTEXT_WINDOW_HARD_MIN` (zero or negative remaining tokens are treated
 *   as "unknown" and are not blocked).
 */
export function evaluateContextWindowGuard(
  remainingTokens: number,
  source: ContextWindowInfo['source'] = 'default'
): ContextWindowGuardResult {
  const shouldWarn = remainingTokens > 0 && remainingTokens < CONTEXT_WINDOW_WARN_BELOW;
  const allowed = !(remainingTokens > 0 && remainingTokens < CONTEXT_WINDOW_HARD_MIN);

  let message: string | undefined;

  if (!allowed) {
    message = `Context window too small (${remainingTokens} tokens remaining). Minimum ${CONTEXT_WINDOW_HARD_MIN} required.`;
    logger.warn(message, { remainingTokens, source });
  } else if (shouldWarn) {
    message = `Context window is low (${remainingTokens} tokens remaining). Consider compacting.`;
    logger.warn(message, { remainingTokens, source });
  }

  return { allowed, shouldWarn, remainingTokens, source, message };
}
