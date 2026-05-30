/**
 * LF-1 — context discipline (loopfixex.md).
 *
 * Same-session loops reuse one persistent CLI adapter across iterations, so the
 * transcript grows unbounded with no orchestrator compaction — the documented
 * root cause behind long-run quality decay ("context rot"). This module holds
 * the pure decision logic for when the loop should recycle its *own* persistent
 * adapter to a fresh session (re-anchoring from durable disk state). The recycle
 * itself lives in the invoker's adapter lifecycle; this keeps the threshold
 * maths unit-testable and out of the lifecycle plumbing.
 *
 * Borrowed *instance* adapters are intentionally NOT handled here — the instance
 * owns its own compaction lifecycle and must never be recycled by the loop.
 */

import { LOOP_CONTEXT_WINDOW_TOKENS } from '../../shared/types/loop.types';

export interface ContextRecycleDecision {
  /** True iff the loop should recycle its persistent adapter now. */
  recycle: boolean;
  /** Cumulative-token utilization (0..1) against the loop context window. */
  utilization: number;
  /** Human-readable reason (for logs + the ITERATION_LOG note). */
  reason: string;
}

/** Cumulative same-session tokens → utilization (0..1) of the loop window. */
export function loopContextUtilization(
  cumulativeTokens: number,
  windowTokens: number = LOOP_CONTEXT_WINDOW_TOKENS,
): number {
  if (windowTokens <= 0) return 0;
  return Math.max(0, cumulativeTokens) / windowTokens;
}

/**
 * Decide whether to recycle the loop's persistent adapter. Pure: no I/O, no
 * adapter handles. `enabled === false` (context discipline off) never recycles.
 */
export function shouldRecycleLoopContext(input: {
  enabled: boolean;
  cumulativeTokens: number;
  resetAtUtilization: number;
  windowTokens?: number;
}): ContextRecycleDecision {
  const windowTokens = input.windowTokens ?? LOOP_CONTEXT_WINDOW_TOKENS;
  const utilization = loopContextUtilization(input.cumulativeTokens, windowTokens);
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  if (!input.enabled) {
    return { recycle: false, utilization, reason: 'context discipline disabled' };
  }
  const recycle = utilization >= input.resetAtUtilization;
  return {
    recycle,
    utilization,
    reason: recycle
      ? `context utilization ${pct(utilization)} ≥ reset ${pct(input.resetAtUtilization)} — recycling to a fresh session`
      : `context utilization ${pct(utilization)} < reset ${pct(input.resetAtUtilization)}`,
  };
}
