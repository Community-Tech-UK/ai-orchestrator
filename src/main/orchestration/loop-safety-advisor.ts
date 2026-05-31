/**
 * Loop safety advisor (claude2_todo #20, loop surface).
 *
 * Adapts the pure {@link critiqueSafety} critic to the autonomous loop: after
 * each iteration is sealed, it critiques the agent's emitted output for
 * destructive operations and unbacked completion claims, and surfaces any
 * *blocking* objections as a structured warning in the logs.
 *
 * Deliberately **non-blocking** and error-isolated — it never affects loop
 * control flow (AIO can't intercept an external CLI mid-turn anyway; this is a
 * post-iteration audit, not a pre-execution gate). The pure
 * {@link critiqueLoopIteration} is exported separately so it can be unit-tested
 * and reused by other surfaces (debate/verify) without the registration.
 */

import type { LoopIteration } from '../../shared/types/loop.types';
import type { LoopCoordinator } from './loop-coordinator';
import { critiqueSafety, type SafetyCritique } from './safety-critic';
import { getLogger } from '../logging/logger';

const logger = getLogger('LoopSafetyAdvisor');

/**
 * Critique a sealed loop iteration. Verification evidence is considered present
 * when the loop actually ran a verify command or recorded a test count (pass or
 * fail) — i.e. *some* verification happened, regardless of outcome.
 */
export function critiqueLoopIteration(iteration: LoopIteration): SafetyCritique {
  const verificationRan =
    iteration.verifyStatus !== 'not-run' ||
    iteration.testPassCount !== null ||
    iteration.testFailCount !== null;
  return critiqueSafety({
    text: iteration.outputExcerpt ?? '',
    hasVerificationEvidence: verificationRan,
  });
}

/**
 * Register the safety advisor as a post-iteration hook on the coordinator.
 * Returns the hook's disposer. Idempotency is the caller's responsibility
 * (register once per coordinator).
 */
export function registerLoopSafetyAdvisor(coordinator: LoopCoordinator): () => void {
  return coordinator.registerIterationHook(({ iteration }) => {
    try {
      const critique = critiqueLoopIteration(iteration);
      if (critique.blocking.length > 0) {
        logger.warn('Loop iteration raised blocking safety objections', {
          loopRunId: iteration.loopRunId,
          seq: iteration.seq,
          summary: critique.summary,
          objections: critique.blocking.map((o) => ({ kind: o.kind, message: o.message })),
        });
      }
    } catch (err) {
      logger.debug('Loop safety advisor failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
