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
 * WS4 (loop-convergence plan) — truthful occupancy. Recycling consumes the
 * adapter's discriminated `ContextUsageObservation` and acts ONLY on a `known`
 * current occupancy sample. The old fallback that divided aggregate loop tokens
 * by a synthetic window is gone: a loop that had processed 7M cumulative tokens
 * while actually sitting at 60k/200k (30%) was recycled at a "3500%"
 * utilization that never existed. Aggregate tokens now populate cost/totals and
 * the diagnostic text only — an `unknown` observation never recycles.
 *
 * Borrowed *instance* adapters are intentionally NOT handled here — the instance
 * owns its own compaction lifecycle and must never be recycled by the loop.
 */

import type { ContextUsageObservation } from '../cli/adapters/base-cli-adapter.types';
import { LOOP_CONTEXT_WINDOW_TOKENS } from '../../shared/types/loop.types';

export type { ContextUsageObservation };

export interface ContextRecycleDecision {
  /** True iff the loop should recycle its persistent adapter now. */
  recycle: boolean;
  /**
   * Proven occupancy utilization (0..1). 0 when the observation is unknown —
   * "we cannot measure it", never a claim of an empty window.
   */
  utilization: number;
  /** Human-readable reason (for logs + the ITERATION_LOG note). */
  reason: string;
  /** True when no recycle decision was possible because occupancy was unknown. */
  occupancyUnavailable: boolean;
}

/**
 * Cumulative same-session tokens → utilization (0..1) of the loop window.
 *
 * WS4: this heuristic is NO LONGER consulted for recycle decisions (it divides
 * an aggregate by a window, which cannot prove occupancy). It remains exported
 * for diagnostic annotations only (e.g. the context-survival stale-cache note).
 */
export function loopContextUtilization(
  cumulativeTokens: number,
  windowTokens: number = LOOP_CONTEXT_WINDOW_TOKENS,
): number {
  if (windowTokens <= 0) return 0;
  return Math.max(0, cumulativeTokens) / windowTokens;
}

const UNKNOWN_REASON_TEXT: Record<Extract<ContextUsageObservation, { status: 'unknown' }>['reason'], string> = {
  'not-reported': 'the adapter has not reported an occupancy sample yet',
  'aggregate-only': 'this adapter mode only exposes aggregate token totals, which cannot prove occupancy',
  'invalid-sample': 'the last occupancy sample had unusable values',
};

/**
 * Decide whether to recycle the loop's persistent adapter. Pure: no I/O, no
 * adapter handles. `enabled === false` (context discipline off) never recycles.
 *
 * Acts only on a `known` observation (current numerator against the provider
 * or model-resolved window it arrived with). `calibratedWindowTokens` — the
 * loop's learned provider window (B6) — is used as the denominator ONLY when a
 * known sample arrives without a usable total, because a learned window is
 * still truly the denominator for a CURRENT-turn numerator. A current
 * numerator is never divided by a cumulative figure or vice versa.
 */
export function shouldRecycleLoopContext(input: {
  enabled: boolean;
  resetAtUtilization: number;
  /** The adapter's discriminated occupancy observation. */
  observation: ContextUsageObservation;
  /** Aggregate same-session tokens — DIAGNOSTIC TEXT ONLY, never the metric. */
  cumulativeTokens?: number;
  /** B6 learned/configured provider window (denominator fallback for a known sample). */
  calibratedWindowTokens?: number;
}): ContextRecycleDecision {
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  if (!input.enabled) {
    return {
      recycle: false,
      utilization: 0,
      reason: 'context discipline disabled',
      occupancyUnavailable: input.observation.status !== 'known',
    };
  }

  const observation = input.observation;
  const aggregateNote = typeof input.cumulativeTokens === 'number' && input.cumulativeTokens > 0
    ? ` (aggregate session tokens: ${Math.floor(input.cumulativeTokens).toLocaleString('en-US')} — cost accounting only, not occupancy)`
    : '';

  if (observation.status === 'unknown') {
    return {
      recycle: false,
      utilization: 0,
      reason: `context occupancy unavailable — ${UNKNOWN_REASON_TEXT[observation.reason]}; `
        + `not recycling${aggregateNote}`,
      occupancyUnavailable: true,
    };
  }

  const usableTotal = Number.isFinite(observation.total) && observation.total > 0
    ? observation.total
    : (typeof input.calibratedWindowTokens === 'number'
        && Number.isFinite(input.calibratedWindowTokens)
        && input.calibratedWindowTokens > 0
      ? input.calibratedWindowTokens
      : null);
  if (!Number.isFinite(observation.used) || observation.used <= 0 || usableTotal === null) {
    return {
      recycle: false,
      utilization: 0,
      reason: `context occupancy unavailable — ${UNKNOWN_REASON_TEXT['invalid-sample']}; `
        + `not recycling${aggregateNote}`,
      occupancyUnavailable: true,
    };
  }

  const utilization = observation.used / usableTotal;
  const recycle = utilization >= input.resetAtUtilization;
  return {
    recycle,
    utilization,
    reason: recycle
      ? `context occupancy ${pct(utilization)} ≥ reset ${pct(input.resetAtUtilization)} — recycling to a fresh session`
      : `context occupancy ${pct(utilization)} < reset ${pct(input.resetAtUtilization)}`,
    occupancyUnavailable: false,
  };
}
