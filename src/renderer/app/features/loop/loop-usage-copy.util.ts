/**
 * Status-strip copy for a loop's in-flight turn.
 *
 * Loop totals only advance when a child iteration settles, so anything the
 * strip renders mid-turn is either unknown or stale. These helpers keep that
 * distinction honest: never present an unsettled value as a settled one, and
 * never fabricate a number (a `0` that means "we don't know yet" reads exactly
 * like a `0` that means "nothing was spent").
 *
 * Extracted from `loop-control.component.ts` so the component stays inside its
 * size ceiling and the wording is directly unit-testable.
 */

import type { LoopInferredPhase } from '@shared/types/loop-health.types';
import { formatCostCents, humanDuration, humanTokens } from './loop-formatters.util';

/**
 * True while the current turn's usage may still be unsettled.
 *
 * `hasRunningIteration` alone is not enough: `LoopStore.runningIterationByLoop`
 * is filled ONLY by the live `loop:iteration-started` push and has no hydration
 * path, so a renderer that connects (or reloads) mid-iteration never learns a
 * turn is in flight. Falling back to the run's own `running` status keeps that
 * session from presenting `0 tok · $0.00` as the whole-run truth while
 * iteration 1 is still going.
 */
export function isUsageUnsettled(hasRunningIteration: boolean, status: string | undefined): boolean {
  return hasRunningIteration || status === 'running';
}

/**
 * Elapsed time for the current turn, or an honest word when it is unknowable.
 *
 * The caller's elapsed value is a hard `0` without a running iteration, and
 * `humanDuration(0)` is `"0s"` — so a reloaded renderer, or the gap between
 * iterations, would otherwise claim a twenty-minute turn had just started.
 */
export function currentIterationLabel(
  hasRunningIteration: boolean,
  elapsedMs: number,
  unsettled: boolean,
  /**
   * L4: advisory phase inferred from the child's command stream. When present
   * it turns "pending" — which reads as "nothing is happening" during a
   * ten-minute test run — into what the agent is actually doing.
   */
  phase?: LoopInferredPhase | null,
): string {
  const phaseLabel = phase ? LOOP_PHASE_LABELS[phase] : null;
  if (hasRunningIteration) {
    return phaseLabel ? `${humanDuration(elapsedMs)} · ${phaseLabel}` : humanDuration(elapsedMs);
  }
  if (!unsettled) return 'idle';
  return phaseLabel ?? 'pending';
}

/** HUD copy for {@link LoopInferredPhase}. */
export const LOOP_PHASE_LABELS: Readonly<Record<LoopInferredPhase, string>> = {
  investigating: 'investigating',
  editing: 'editing',
  verifying: 'running checks',
  reviewing: 'reviewing',
};

/** `12.3k tok` when settled, `tokens pending` / `… settled + current pending` while a turn runs. */
export function activeTokenUsage(totalTokens: number, unsettled: boolean): string {
  if (!unsettled) return humanTokens(totalTokens);
  return totalTokens > 0
    ? `${humanTokens(totalTokens)} settled + current pending`
    : 'tokens pending';
}

/** Cost counterpart to {@link activeTokenUsage}. */
export function activeCostUsage(totalCostCents: number, unsettled: boolean): string {
  if (!unsettled) return formatCostCents(totalCostCents);
  return totalCostCents > 0
    ? `${formatCostCents(totalCostCents)} settled + current pending`
    : 'cost pending';
}
