/**
 * Ledger-progress stall detection — the non-convergence backstop.
 *
 * The review-driven stall guard in the coordinator (`maxStalledReviewIterations`)
 * resets its counter whenever an iteration makes ANY production file change. A
 * loop that edits files every round but never CLOSES a `LOOP_TASKS.md` item —
 * e.g. it keeps re-expanding an open-ended "continue remaining slices" bucket as
 * fast as it drains it — therefore looks productive forever and never trips that
 * guard, spinning all the way to the iteration cap.
 *
 * Observed: loop-1782864004679 ran 24 IMPLEMENT iterations with the ledger
 * open-count oscillating 6 → 2 → 9 → 5 → 4 (never converging), burning ~$1138 /
 * 223M tokens before a manual cancel — every early-stop net bypassed.
 *
 * This module tracks the *lowest* ledger open-count seen so far. Net progress is
 * defined as reaching a new low. When the open-count has failed to reach a new
 * low for N consecutive iterations, the loop is churning without closing items —
 * a genuine stall, independent of file churn.
 *
 * Pure module — no I/O — so it is trivially unit-tested and shared.
 */

import type { CompletionSignalEvidence } from '../../shared/types/loop-state.types';

/**
 * Default backstop: 8 consecutive iterations with no new ledger low. High enough
 * that lumpy-but-real progress (an item that legitimately takes several
 * iterations to close) never trips it; low enough that a non-convergent loop
 * stops in ~8 iterations instead of running to the hard iteration cap.
 */
export const DEFAULT_MAX_LEDGER_STALL_ITERATIONS = 8;

export interface LedgerProgressState {
  /** Lowest open-item count observed so far (undefined until the first reading). */
  ledgerOpenCountBest?: number;
  /** Consecutive iterations since the open-count last reached a new low. */
  ledgerNoImprovementIterations?: number;
}

export interface LedgerProgressUpdate {
  ledgerOpenCountBest: number;
  ledgerNoImprovementIterations: number;
  /** True when this reading set a new low (net ledger progress). */
  improved: boolean;
}

/**
 * Extract the current ledger open-item count from a set of completion signals.
 * Returns `null` when no ledger is active (no `ledger-complete` signal, or it
 * carried no structured `openCount`), so callers can skip stall tracking for
 * non-ledger loops rather than treating "no ledger" as "zero open".
 */
export function extractLedgerOpenCount(
  signals: readonly CompletionSignalEvidence[],
): number | null {
  const ledger = signals.find((s) => s.id === 'ledger-complete');
  if (!ledger || typeof ledger.openCount !== 'number' || !Number.isFinite(ledger.openCount)) {
    return null;
  }
  return Math.max(0, Math.floor(ledger.openCount));
}

/**
 * Fold a new open-count reading into the running best / no-improvement tracker.
 * A strictly lower open-count is net progress (reset the counter to 0); anything
 * else — the same count, or a higher one because the ledger was re-expanded —
 * increments the no-improvement counter.
 */
export function updateLedgerProgress(
  prev: LedgerProgressState,
  openCount: number,
): LedgerProgressUpdate {
  const normalized = Math.max(0, Math.floor(openCount));
  const best = prev.ledgerOpenCountBest;
  if (best === undefined || normalized < best) {
    return { ledgerOpenCountBest: normalized, ledgerNoImprovementIterations: 0, improved: true };
  }
  return {
    ledgerOpenCountBest: best,
    ledgerNoImprovementIterations: (prev.ledgerNoImprovementIterations ?? 0) + 1,
    improved: false,
  };
}

/**
 * True when the ledger has stalled: it still has open items (`openCount > 0`)
 * and the open-count has failed to reach a new low for `>= limit` consecutive
 * iterations. A fully-resolved ledger (`openCount === 0`) is never a stall — the
 * completion gate handles that case.
 */
export function isLedgerStalled(
  tracker: LedgerProgressState,
  openCount: number,
  limit: number = DEFAULT_MAX_LEDGER_STALL_ITERATIONS,
): boolean {
  if (openCount <= 0) return false;
  const effective = Math.max(1, Math.floor(limit));
  return (tracker.ledgerNoImprovementIterations ?? 0) >= effective;
}
