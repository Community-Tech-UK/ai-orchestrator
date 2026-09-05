/**
 * WS5 — park a loop as a SUCCESSFUL `completed-needs-review` because a
 * degraded/failed attempt cannot be safely replayed (writes were observed, or
 * the workspace state is unprovable).
 *
 * Extracted from `loop-coordinator.ts` to keep that file inside its size
 * ceiling. Behaviour is unchanged: the attempt evidence is sealed into
 * `endEvidence` so changed paths and the observer-failure reason survive a
 * restart, and the iteration is never replayed.
 */

import { getLogger } from '../logging/logger';
import {
  buildAttemptReviewEndEvidence,
  type LoopInvocationAttemptEvidence,
} from './loop-invocation-attempt';
import type { LoopState } from '../../shared/types/loop.types';

const logger = getLogger('LoopCoordinator');

export function pauseIterationForAttemptReview(args: {
  state: LoopState;
  seq: number;
  evidence: LoopInvocationAttemptEvidence;
  reason: string;
  emit: (eventName: string, payload: unknown) => void;
  terminate: (status: LoopState['status'], reason: string) => void;
}): void {
  const { state, seq, evidence } = args;
  const fullReason =
    `Iteration ${seq + 1} paused for review instead of an automatic replay: ${args.reason}`;
  state.endEvidence = buildAttemptReviewEndEvidence(evidence, seq);
  logger.warn('Pausing loop for attempt review (side-effect-aware retry)', {
    loopRunId: state.id,
    seq,
    workspaceEffect: evidence.workspaceEffect,
    changedPathCount: evidence.filesChanged.length,
  });
  args.emit('loop:completed-needs-review', {
    loopRunId: state.id,
    reason: fullReason,
    acceptedByOperator: false,
  });
  args.terminate('completed-needs-review', fullReason);
}
