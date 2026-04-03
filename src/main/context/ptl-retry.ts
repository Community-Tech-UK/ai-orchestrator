/**
 * Prompt-Too-Long (PTL) Retry Handler
 *
 * When an LLM API returns a context overflow error (prompt too long),
 * this utility catches the error, drops the oldest conversation turns,
 * and retries transparently — preventing hard crashes mid-task.
 *
 * Inspired by:
 * - Actual Claude Code: PTL retry loop dropping oldest API-round groups (compact.ts)
 * - Codex: History trimming oldest-to-newest before compaction (compact_remote.rs)
 * - OpenClaw: extractObservedOverflowTokenCount from error messages
 *
 * Configuration via LIMITS.PTL_MAX_RETRIES and LIMITS.PTL_DROP_RATIO.
 */

import { getLogger } from '../logging/logger';
import { LIMITS } from '../../shared/constants/limits';

const logger = getLogger('PTLRetry');

/**
 * A conversation turn that can be dropped during PTL recovery.
 */
export interface PTLTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  tokenEstimate: number;
  /** Whether this turn should be protected from dropping (e.g., system prompt) */
  protected?: boolean;
}

/**
 * Result of a PTL retry attempt.
 */
export interface PTLRetryResult<T> {
  /** Whether the operation succeeded (possibly after retries) */
  success: boolean;
  /** The result from the successful call, if any */
  result?: T;
  /** Number of retries that were needed */
  retriesUsed: number;
  /** Turn IDs that were dropped during retry */
  droppedTurnIds: string[];
  /** Estimated tokens saved by dropping turns */
  tokensSaved: number;
  /** Error if all retries exhausted */
  error?: string;
}

/**
 * Patterns that indicate a prompt-too-long / context overflow error.
 * Covers Anthropic, OpenAI, Google, and generic error formats.
 */
const PTL_ERROR_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /context.?window.?exceeded/i,
  /context_length_exceeded/i,
  /maximum context length/i,
  /token limit exceeded/i,
  /input.*too long/i,
  /exceeds the model's maximum/i,
  /max_tokens.*exceeded/i,
] as const;

/**
 * Extract the observed token count from an error message, if present.
 * Common format: "prompt is too long: 245000 tokens > 200000 maximum"
 */
export function extractOverflowTokenCount(errorMessage: string): { observed?: number; maximum?: number } {
  // Pattern: "N tokens > M maximum" or "N tokens exceeds M"
  const match = errorMessage.match(/(\d[\d,]*)\s*tokens?\s*(?:>|exceeds?|over)\s*(\d[\d,]*)/i);
  if (match) {
    return {
      observed: parseInt(match[1].replace(/,/g, ''), 10),
      maximum: parseInt(match[2].replace(/,/g, ''), 10),
    };
  }

  // Pattern: "maximum context length is M tokens, however you requested N"
  const altMatch = errorMessage.match(/maximum.*?(\d[\d,]*)\s*tokens.*?requested.*?(\d[\d,]*)/i);
  if (altMatch) {
    return {
      maximum: parseInt(altMatch[1].replace(/,/g, ''), 10),
      observed: parseInt(altMatch[2].replace(/,/g, ''), 10),
    };
  }

  return {};
}

/**
 * Check if an error is a prompt-too-long / context overflow error.
 */
export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return PTL_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Determine how many turns to drop based on the overflow gap.
 *
 * Strategy: If we can parse token counts from the error, compute the exact
 * gap and drop enough turns to cover it. Otherwise, drop a fixed percentage
 * (LIMITS.PTL_DROP_RATIO, default 20%) of droppable turns.
 */
function computeDropCount(
  turns: PTLTurn[],
  error: unknown,
): { dropCount: number; reason: string } {
  const droppable = turns.filter(t => !t.protected);
  if (droppable.length === 0) {
    return { dropCount: 0, reason: 'no droppable turns' };
  }

  const message = error instanceof Error ? error.message : String(error);
  const { observed, maximum } = extractOverflowTokenCount(message);

  if (observed && maximum && observed > maximum) {
    // Calculate exact gap and drop enough oldest turns to cover it
    const gap = observed - maximum;
    let accumulated = 0;
    let count = 0;
    for (const turn of droppable) {
      if (accumulated >= gap) break;
      accumulated += turn.tokenEstimate;
      count++;
    }
    // Drop at least 1 extra turn for safety
    return {
      dropCount: Math.min(count + 1, droppable.length),
      reason: `gap=${gap} tokens, dropping ${count + 1} oldest turns`,
    };
  }

  // Fallback: drop fixed percentage of droppable turns
  const dropCount = Math.max(1, Math.ceil(droppable.length * LIMITS.PTL_DROP_RATIO));
  return {
    dropCount,
    reason: `no token gap parsed, dropping ${Math.round(LIMITS.PTL_DROP_RATIO * 100)}% (${dropCount}) of ${droppable.length} droppable turns`,
  };
}

/**
 * Execute an async operation with PTL retry.
 *
 * If the operation fails with a context overflow error, this will:
 * 1. Drop the oldest unprotected turns
 * 2. Call the operation again with the pruned turn list
 * 3. Repeat up to LIMITS.PTL_MAX_RETRIES times
 *
 * @param turns - The conversation turns (will be pruned on retry)
 * @param operation - The async operation to attempt. Receives pruned turns.
 * @returns PTLRetryResult with the outcome
 */
export async function executeWithPTLRetry<T>(
  turns: PTLTurn[],
  operation: (remainingTurns: PTLTurn[]) => Promise<T>,
): Promise<PTLRetryResult<T>> {
  let currentTurns = [...turns];
  const allDroppedIds: string[] = [];
  let totalTokensSaved = 0;

  for (let attempt = 0; attempt <= LIMITS.PTL_MAX_RETRIES; attempt++) {
    try {
      const result = await operation(currentTurns);
      return {
        success: true,
        result,
        retriesUsed: attempt,
        droppedTurnIds: allDroppedIds,
        tokensSaved: totalTokensSaved,
      };
    } catch (error) {
      if (!isContextOverflowError(error) || attempt >= LIMITS.PTL_MAX_RETRIES) {
        // Not a PTL error, or we've exhausted retries — propagate
        if (isContextOverflowError(error)) {
          logger.error('PTL retry exhausted', error as Error, {
            attempts: attempt + 1,
            totalDropped: allDroppedIds.length,
            totalTokensSaved,
          });
        }
        return {
          success: false,
          retriesUsed: attempt,
          droppedTurnIds: allDroppedIds,
          tokensSaved: totalTokensSaved,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // PTL error — drop oldest unprotected turns and retry
      const { dropCount, reason } = computeDropCount(currentTurns, error);
      if (dropCount === 0) {
        logger.warn('PTL retry: nothing to drop (all turns protected)');
        return {
          success: false,
          retriesUsed: attempt,
          droppedTurnIds: allDroppedIds,
          tokensSaved: totalTokensSaved,
          error: 'All turns are protected; cannot recover from context overflow',
        };
      }

      // Separate protected and droppable, then drop oldest droppable
      const protectedTurns = currentTurns.filter(t => t.protected);
      const droppableTurns = currentTurns.filter(t => !t.protected);

      const droppedTurns = droppableTurns.splice(0, dropCount);
      const droppedTokens = droppedTurns.reduce((sum, t) => sum + t.tokenEstimate, 0);

      allDroppedIds.push(...droppedTurns.map(t => t.id));
      totalTokensSaved += droppedTokens;

      // Reassemble: protected first, then surviving droppable (preserves order)
      currentTurns = [...protectedTurns, ...droppableTurns];

      logger.warn('PTL retry: dropping turns and retrying', {
        attempt: attempt + 1,
        dropCount,
        droppedTokens,
        remainingTurns: currentTurns.length,
        reason,
      });
    }
  }

  // Should not reach here, but just in case
  return {
    success: false,
    retriesUsed: LIMITS.PTL_MAX_RETRIES,
    droppedTurnIds: allDroppedIds,
    tokensSaved: totalTokensSaved,
    error: 'PTL retry loop exited unexpectedly',
  };
}
