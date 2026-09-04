/**
 * Ping-pong builder done-declaration resolution.
 *
 * A ping-pong reviewer round only opens once the builder has declared done —
 * that is one half of the mutual-convergence contract. Two routes count, and
 * they are equally authoritative:
 *
 *   a. a *sufficient* completion signal from `LoopCompletionDetector` — the
 *      structured, file-backed route (`ledger-complete` once every
 *      LOOP_TASKS.md leaf is resolved, `declared-complete` from the loop-control
 *      `complete` tool);
 *   b. the `[[LOOP:CLEAN_REVIEW]]` sentinel in the iteration prose, via
 *      `classifyCleanReview`.
 *
 * Route (a) is checked first and short-circuits the classifier: when the
 * detector has already concluded the run is complete there is nothing a model
 * call can add, and skipping it saves a per-iteration `loopScoring` round-trip.
 *
 * ## Why (a) exists
 *
 * When ping-pong is enabled it owns the ONLY completion-signal-driven terminal
 * path — the coordinator's `hasSufficientSignal` branch is an `else if` sitting
 * behind it (`loop-coordinator.ts`, the verify-before-stop seam). Gating rounds
 * solely on route (b) meant a loop that had genuinely finished — ledger fully
 * resolved, OUTSTANDING.md empty — but whose prose never emitted the sentinel
 * could never open a round. `pp.roundCount` stayed 0, which in turn made the
 * `roundCount >= maxRounds` backstop unreachable by construction, so the loop
 * ran to its iteration cap.
 *
 * Note that `classifyCleanReview` cannot rescue this on its own: it has no path
 * to `clean: true` without the literal sentinel (its model backend can only ever
 * *confirm* not-clean, and a deterministic clean verdict is deliberately
 * downgraded to `UNCLEAR_CLEAN_REVIEW`). That asymmetry is a sound guard against
 * a premature stop on optimistic prose and is intentionally left alone.
 *
 * Observed live on loop `loop-1787241037235-b6fe2309`: 5 iterations, 2h40m,
 * $20.25, ping-pong round 0/15 and reviewer spend $0.00, with `ledger-complete`
 * firing on every single iteration.
 *
 * Accepting (a) cannot cause a premature stop: it opens a *review round*, it does
 * not terminate the loop. The reviewer still has to converge.
 */

import type { CompletionSignalEvidence } from '../../shared/types/loop.types';
import type {
  LoopCleanReviewClassification,
  LoopCleanReviewClassifier,
  LoopCleanReviewClassifierInput,
} from './loop-clean-review-classifier';

export interface PingPongBuilderDoneVerdict extends LoopCleanReviewClassification {
  /**
   * The completion signal that decided this verdict, when route (a) fired.
   * Undefined when the verdict came from the prose classifier.
   */
  signal?: CompletionSignalEvidence;
}

export interface PingPongBuilderDoneOptions {
  /**
   * Work hash of the last iteration that already opened a ping-pong round on
   * `ledger-complete`. A later seal with the same hash must not re-open a
   * reviewer (T33).
   */
  lastLedgerCompleteWorkHash?: string;
  currentWorkHash?: string;
}

/**
 * Decide whether the builder has declared done for this iteration.
 *
 * @param completionSignals This iteration's signals from `LoopCompletionDetector`.
 *   Absent/empty ⇒ sentinel-only behaviour.
 * @param classifyCleanReview Prose classifier, called only when no sufficient
 *   signal is present (and never for a stale ledger-complete).
 * @param classifierInput Input for that classifier.
 */
export async function resolvePingPongBuilderDone(
  completionSignals: readonly CompletionSignalEvidence[] | undefined,
  classifyCleanReview: LoopCleanReviewClassifier,
  classifierInput: LoopCleanReviewClassifierInput,
  options?: PingPongBuilderDoneOptions,
): Promise<PingPongBuilderDoneVerdict> {
  const sufficientSignal = completionSignals?.find((signal) => signal.sufficient);
  if (sufficientSignal) {
    if (sufficientSignal.id === 'ledger-complete') {
      const last = options?.lastLedgerCompleteWorkHash;
      const current = options?.currentWorkHash;
      if (last !== undefined && current !== undefined && last === current) {
        return {
          clean: false,
          confidence: 1,
          reason: 'stale ledger-complete; workHash unchanged since last ping-pong round',
        };
      }
    }
    return {
      clean: true,
      confidence: 1,
      reason: `completion signal '${sufficientSignal.id}': ${sufficientSignal.detail}`,
      signal: sufficientSignal,
    };
  }
  return classifyCleanReview(classifierInput);
}

/**
 * Announce a round that opened via the structured signal route.
 *
 * Worth its own activity line: this is precisely the case that used to happen
 * never, so "why did a round finally start?" needs a visible answer in the feed.
 * No-op for the sentinel route, which `loop:fresh-eyes-review-started` already
 * covers.
 */
export function emitBuilderDoneSignalActivity(
  emit: (eventName: string, payload: unknown) => void,
  args: { loopRunId: string; seq: number; stage: string; verdict: PingPongBuilderDoneVerdict },
): void {
  const { signal } = args.verdict;
  if (!signal) return;
  emit('loop:activity', {
    loopRunId: args.loopRunId,
    seq: args.seq,
    stage: args.stage,
    timestamp: Date.now(),
    kind: 'status',
    message: `Ping-pong round opened on completion signal '${signal.id}'`,
    detail: { signalId: signal.id, reason: args.verdict.reason },
  });
}
