/**
 * WS5 — stop or interactively pause a loop because a
 * degraded/failed attempt cannot be safely replayed (writes were observed, or
 * the workspace state is unprovable).
 *
 * Extracted from `loop-coordinator.ts` to keep that file inside its size
 * ceiling. The attempt evidence is sealed into
 * `endEvidence` so changed paths and the observer-failure reason survive a
 * restart, and the iteration is never replayed.
 */

import { getLogger } from '../logging/logger';
import {
  buildAttemptReviewEndEvidence,
  type LoopInvocationAttemptEvidence,
} from './loop-invocation-attempt';
import { createLoopPendingInput, type LoopState, type ProgressSignalEvidence } from '../../shared/types/loop.types';
import { notifyLoopFailedStepPause } from './loop-terminal-notification';

const logger = getLogger('LoopCoordinator');

export function handleFailedAttempt(args: {
  state: LoopState;
  seq: number;
  evidence: LoopInvocationAttemptEvidence;
  reason: string;
  emit: (eventName: string, payload: unknown) => void;
  terminate: (status: LoopState['status'], reason: string) => void;
  pause?: (reason: string, signal: ProgressSignalEvidence) => void;
  notify?: (state: LoopState, reason: string) => void;
}): 'stopped' | 'paused' {
  const { state, seq, evidence } = args;
  const fullReason =
    `Step ${seq + 1} stopped without finishing (${args.reason}) and Harness can't tell what it changed. `
    + 'Nothing was merged. Check the files, then Resume or Stop.';
  state.endEvidence = { ...state.endEvidence, ...buildAttemptReviewEndEvidence(evidence, seq) };
  logger.warn('Loop step failed (side-effect-aware retry)', {
    loopRunId: state.id,
    seq,
    workspaceEffect: evidence.workspaceEffect,
    changedPathCount: evidence.filesChanged.length,
  });
  if (state.config.onFailedStep !== 'pause') {
    args.terminate('attempt-failed', fullReason);
    return 'stopped';
  }
  state.status = 'paused';
  state.endReason = fullReason;
  state.pausedForInput = true;
  state.pendingInterventions.push(createLoopPendingInput(
    `The previous attempt at step ${seq + 1} stopped without finishing (${args.reason}). `
    + "Harness can't tell what it changed. Before you continue, run `git status` and `git diff`, "
    + 'keep what is correct, undo anything half-finished, then carry on with the task.',
    { source: 'failed-step' },
  ));
  const signal: ProgressSignalEvidence = { id: 'STEP_FAILED', verdict: 'CRITICAL', message: fullReason,
    detail: { seq, workspaceEffect: evidence.workspaceEffect, changedPaths: evidence.filesChanged.map((file) => file.path) } };
  if (args.pause) args.pause(fullReason, signal);
  else {
    args.emit('loop:paused-no-progress', { loopRunId: state.id, reason: fullReason, signal });
    args.emit('loop:state-changed', { loopRunId: state.id, state });
  }
  (args.notify ?? notifyLoopFailedStepPause)(state, fullReason);
  return 'paused';
}
