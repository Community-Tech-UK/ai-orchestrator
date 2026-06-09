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
 *
 * Prefers REAL context occupancy (`occupancyTokens` / `occupancyWindowTokens`,
 * from the adapter's last per-API-call usage including cache tokens) when the
 * caller has it. Falls back to the legacy cumulative-token heuristic —
 * cumulative same-session generation tokens against a synthetic 200k window —
 * which only loosely correlates with actual context fill (it excludes cache
 * reads and double-counts nothing that is still resident).
 */
export function shouldRecycleLoopContext(input: {
  enabled: boolean;
  cumulativeTokens: number;
  resetAtUtilization: number;
  windowTokens?: number;
  /** Real context occupancy from the adapter's last per-call usage, when known. */
  occupancyTokens?: number;
  /** Context window matching `occupancyTokens`. Defaults to `windowTokens`. */
  occupancyWindowTokens?: number;
}): ContextRecycleDecision {
  const windowTokens = input.windowTokens ?? LOOP_CONTEXT_WINDOW_TOKENS;
  const hasOccupancy =
    typeof input.occupancyTokens === 'number' &&
    Number.isFinite(input.occupancyTokens) &&
    input.occupancyTokens > 0;
  const utilization = hasOccupancy
    ? loopContextUtilization(input.occupancyTokens!, input.occupancyWindowTokens ?? windowTokens)
    : loopContextUtilization(input.cumulativeTokens, windowTokens);
  const metric = hasOccupancy ? 'context occupancy' : 'cumulative tokens (approximate)';
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  if (!input.enabled) {
    return { recycle: false, utilization, reason: 'context discipline disabled' };
  }
  const recycle = utilization >= input.resetAtUtilization;
  return {
    recycle,
    utilization,
    reason: recycle
      ? `${metric} ${pct(utilization)} ≥ reset ${pct(input.resetAtUtilization)} — recycling to a fresh session`
      : `${metric} ${pct(utilization)} < reset ${pct(input.resetAtUtilization)}`,
  };
}
