/**
 * Claude CLI `result` stream-message usage handling.
 *
 * Extracted from `claude-cli-adapter.ts` so the adapter stays inside its LOC
 * ceiling. Callers pass the live adapter host; this module does not own
 * adapter state. Behaviour matches the previous `processCliMessage` case.
 */

import type { RawCliPayload } from './claude-cli-adapter.types';

export interface ClaudeResultUsageHost {
  emit(event: string, ...args: unknown[]): boolean;
  lastKnownContextWindow: number;
  readonly contextWindowFloor: number;
  hasPerCallUsageThisTurn: boolean;
}

/**
 * Refresh the context window from a `result` message and emit the turn's
 * context (or cost-only) event.
 */
export function applyClaudeResultUsage(host: ClaudeResultUsageHost, resultMsg: RawCliPayload): void {
  // Update context window size from modelUsage (the contextWindow field
  // is per-model, not cumulative — safe to use).
  // IMPORTANT: modelUsage.inputTokens / .outputTokens are SESSION-LEVEL
  // CUMULATIVE totals, NOT current context occupancy. Using them for
  // context % would massively overcount after multi-call agentic turns.
  if (resultMsg.modelUsage) {
    const modelKeys = Object.keys(resultMsg.modelUsage);
    if (modelKeys.length > 0) {
      const modelData = resultMsg.modelUsage[modelKeys[0]];
      // Use CLI-reported context window but never go below our known floor.
      const cliReported = modelData.contextWindow || host.lastKnownContextWindow;
      const contextWindow = Math.max(cliReported, host.contextWindowFloor);
      host.lastKnownContextWindow = contextWindow;
    }
  }

  // Emit context usage only if we didn't already get accurate per-call
  // usage from assistant or system messages this turn.
  if (!host.hasPerCallUsageThisTurn) {
    const contextWindow = host.lastKnownContextWindow;
    let totalUsedTokens = 0;

    if (resultMsg.modelUsage) {
      // Fallback: use cumulative modelUsage when no per-call data available.
      // This overcounts but is better than showing 0%.
      const modelKeys = Object.keys(resultMsg.modelUsage);
      if (modelKeys.length > 0) {
        const modelData = resultMsg.modelUsage[modelKeys[0]];
        totalUsedTokens =
          (modelData.inputTokens || 0) +
          (modelData.outputTokens || 0);
      }
    } else if (resultMsg.usage) {
      totalUsedTokens =
        (resultMsg.usage.input_tokens || 0) +
        (resultMsg.usage.cache_creation_input_tokens || 0) +
        (resultMsg.usage.cache_read_input_tokens || 0) +
        (resultMsg.usage.output_tokens || 0);
    }

    if (totalUsedTokens > 0) {
      const percentage = (totalUsedTokens / contextWindow) * 100;
      const costEstimate = resultMsg.total_cost_usd || 0;

      host.emit('context', {
        used: totalUsedTokens,
        total: contextWindow,
        percentage: Math.min(percentage, 100),
        costEstimate
      });
    }
  } else if (resultMsg.total_cost_usd !== undefined) {
    // We have accurate per-call usage but result has the session cost.
    // Emit a cost-only event using the 'cost' channel so downstream
    // can merge it without overwriting accurate token values.
    host.emit('cost', { costEstimate: resultMsg.total_cost_usd });
  }
}
