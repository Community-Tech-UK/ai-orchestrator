/**
 * Completion-evidence recording for the loop coordinator.
 *
 * Split out of loop-coordinator.ts. Given a resolved completion attempt, persist
 * the positive evidence (verify-passed / fresh-eyes-clean) to the evidence store,
 * and — on a contradiction (verify regressed after a prior pass) — append a
 * convergence note and force a fresh-eyes pass on the next attempt.
 *
 * Fail-soft: the caller resolves the store; this function only runs when a store
 * exists. `convergenceNotes` is the coordinator's map, mutated in place.
 */
import { getLogger } from '../logging/logger';
import type { CompletionSignalEvidence, LoopState } from '../../shared/types/loop.types';
import type { EvidenceResolution } from './evidence-resolver';
import type { EvidenceStore } from './evidence-store';

const logger = getLogger('LoopCoordinator');

export interface CompletionEvidenceInput {
  verifyPassed: boolean;
  freshEyesRan: boolean;
  freshEyesBlockingCount: number;
  freshEyesErrored: boolean;
  resolution: EvidenceResolution;
}

export function recordCompletionEvidence(
  state: LoopState,
  candidate: CompletionSignalEvidence,
  ev: CompletionEvidenceInput,
  store: EvidenceStore,
  convergenceNotes: Map<string, string>,
): void {
  const loopId = state.id;
  const target = candidate.id;

  // Contradiction: verify regressed after a prior pass for this target.
  if (ev.resolution.outcome === 'verify-failed') {
    const priorVerified = store.getForTarget(loopId, target, 'verified');
    if (priorVerified.length > 0) {
      const note =
        `verify regressed after ${priorVerified.length} previous pass(es) — ` +
        'the work broke something that was passing before';
      const existing = convergenceNotes.get(loopId);
      convergenceNotes.set(loopId, existing ? `${existing}; ${note}` : note);
      // A4: schedule a forced fresh-eyes pass on the next completion attempt
      // so a second opinion evaluates the workspace before accepting again.
      state.freshEyesForcedByContradiction = true;
      logger.info('Loop verify regressed after a prior pass — forcing fresh-eyes on next attempt', {
        loopRunId: loopId,
        target,
        priorPasses: priorVerified.length,
      });
    }
    return; // nothing positive to persist on a failed verify
  }

  if (ev.verifyPassed) {
    store.record({
      loopId,
      target,
      kind: 'verify-passed',
      state: 'verified',
      sourceMetadata: { signalId: candidate.id, attempt: state.completionAttempts },
    });
  }
  if (ev.freshEyesRan && ev.freshEyesBlockingCount === 0 && !ev.freshEyesErrored) {
    store.record({
      loopId,
      target,
      kind: 'fresh-eyes-clean',
      state: 'reviewed',
      sourceMetadata: { signalId: candidate.id, verifyPassed: ev.verifyPassed },
    });
  }
}
