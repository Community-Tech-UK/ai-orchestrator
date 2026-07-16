/**
 * WS4 (loop-convergence plan) — invoker-side glue for LF-1 context discipline.
 *
 * Resolves the adapter's discriminated occupancy observation (adapters outside
 * the base contract — remote proxies — truthfully resolve to unknown), asks the
 * pure decision function whether to recycle, and reports whether the caller
 * should emit the ONE bounded "occupancy unavailable" diagnostic for this loop
 * so a long unknown-occupancy run is legible instead of silently never
 * recycling. Pure — no I/O — so the seam is unit-testable without the invoker.
 */

import type { ContextUsageObservation } from '../cli/adapters/base-cli-adapter.types';
import {
  shouldRecycleLoopContext,
  type ContextRecycleDecision,
} from './loop-context-discipline';

export interface LoopContextDisciplineInput {
  /** The persistent loop adapter (any shape; contract method is optional). */
  adapter: unknown;
  enabled: boolean;
  resetAtUtilization: number;
  /** Aggregate same-session tokens — diagnostics only, never the metric. */
  cumulativeTokens: number;
  /** B6 learned/configured provider window (denominator fallback for a known sample). */
  calibratedWindowTokens?: number;
  /** True when this loop already received the bounded unavailable diagnostic. */
  alreadyNotifiedUnavailable: boolean;
}

export interface LoopContextDisciplineOutcome {
  decision: ContextRecycleDecision;
  /** True when the caller should emit the once-per-loop unavailable diagnostic now. */
  notifyUnavailable: boolean;
}

export function evaluateLoopContextDiscipline(
  input: LoopContextDisciplineInput,
): LoopContextDisciplineOutcome {
  const source = input.adapter as { getLastContextUsage?: () => ContextUsageObservation } | undefined;
  const observation: ContextUsageObservation = source?.getLastContextUsage?.()
    ?? { status: 'unknown', reason: 'not-reported' };
  const decision = shouldRecycleLoopContext({
    enabled: input.enabled,
    resetAtUtilization: input.resetAtUtilization,
    observation,
    cumulativeTokens: input.cumulativeTokens,
    ...(typeof input.calibratedWindowTokens === 'number'
      && Number.isFinite(input.calibratedWindowTokens)
      && input.calibratedWindowTokens > 0
      ? { calibratedWindowTokens: input.calibratedWindowTokens }
      : {}),
  });
  return {
    decision,
    notifyUnavailable: decision.occupancyUnavailable
      && input.enabled
      && !input.alreadyNotifiedUnavailable,
  };
}
