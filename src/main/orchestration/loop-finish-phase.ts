import type { LoopConfig, LoopIteration, LoopState } from '../../shared/types/loop.types';
import type { LedgerConvergenceState } from '../../shared/types/loop-state.types';
import { createLoopPendingInput } from '../../shared/types/loop.types';
import { unresolvedKnownTaskIds } from './loop-ledger-progress';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { loopStateCwd } from './loop-cwd';
import { OUTSTANDING_NEEDS_HUMAN_HEADING } from './loop-stage-files';

export const LOOP_FINISH_PHASE_MAX_ROUNDS = 3;
export interface FinishCheck {
  check: 'self-review' | 'verify' | 'second-opinion' | 'final-audit';
  result: 'passed' | 'skipped' | 'already-failing' | 'failed';
  detail: string;
}
export interface FinishOutcome {
  kind: 'completed' | 'completed-with-notes' | 'needs-sign-off';
  reason: string;
  checks: FinishCheck[];
}
export interface ReviewDrivenTerminal {
  status: 'completed' | 'completed-needs-review' | 'needs-sign-off';
  reason: string;
  checks?: FinishCheck[];
}

export function isLedgerClosed(tracker: LedgerConvergenceState | undefined): boolean {
  return !!tracker && !tracker.inventoryInvalid && Object.keys(tracker.knownTaskStates).length > 0
    && unresolvedKnownTaskIds(tracker).length === 0;
}

export function isStrictReviewDrivenLoop(config: LoopConfig): boolean {
  return Boolean(config.planFile) || config.completion.requireCompletedFileRename === true;
}

export function queueFinishCard(state: LoopState, round: number): void {
  const paths = resolveLoopArtifactPaths(loopStateCwd(state.config), state.id);
  state.pendingInterventions.push(createLoopPendingInput(
    `Finish round ${round} of ${LOOP_FINISH_PHASE_MAX_ROUNDS}. Every item in \`${paths.tasks}\` is done or deferred. `
    + "Use this round only to fix defects in the goal's own scope and to make the checks pass. "
    + 'Before adding another investigation or validation step, identify the remaining acceptance criterion it resolves. '
    + 'If no acceptance criterion remains, give the clean-review statement and sentinel instead. '
    + `Write any new idea under ${OUTSTANDING_NEEDS_HUMAN_HEADING} in \`${paths.outstanding}\`, with a Recommendation, rather than starting it.`,
    { source: 'finish-phase' },
  ));
}

/** The closing iteration enters the phase; only the three following rounds consume its budget. */
export function updateFinishPhase(
  state: LoopState,
  iteration: LoopIteration,
  emit?: (event: string, payload: unknown) => void,
): void {
  if (state.config.completion.mode !== 'review-driven' || state.currentStage !== 'IMPLEMENT'
      || state.loopTasksLedgerResolvedAtStart || !isLedgerClosed(state.ledgerConvergence)) {
    delete state.finishPhase;
    state.pendingInterventions = state.pendingInterventions.filter((input) => input.source !== 'finish-phase');
    return;
  }
  if (!state.finishPhase) {
    state.finishPhase = { enteredAtSeq: iteration.seq, roundsUsed: 0, maxRounds: LOOP_FINISH_PHASE_MAX_ROUNDS };
    emit?.('loop:activity', { loopRunId: state.id, seq: iteration.seq, stage: iteration.stage,
      timestamp: Date.now(), kind: 'status', message: 'Finishing up: the task list is closed (round 1 of 3)' });
    queueFinishCard(state, 1);
    return;
  }
  const used = Math.max(0, iteration.seq - state.finishPhase.enteredAtSeq);
  if (used === state.finishPhase.roundsUsed) return;
  state.finishPhase.roundsUsed = Math.min(used, state.finishPhase.maxRounds);
  if (used < state.finishPhase.maxRounds) queueFinishCard(state, used + 1);
}

export function resetFinishBudget(state: LoopState): void {
  if (!state.finishPhase) return;
  state.pendingInterventions = state.pendingInterventions.filter((input) => input.source !== 'finish-phase');
  state.finishPhase = { enteredAtSeq: Math.max(0, state.totalIterations - 1), roundsUsed: 0, maxRounds: LOOP_FINISH_PHASE_MAX_ROUNDS };
  state.consecutiveCleanReviewPasses = 0;
  queueFinishCard(state, 1);
}

export function decideFinishOutcome(input: { state: LoopState; clean: boolean; checks: FinishCheck[] }): FinishOutcome | null {
  const { state, clean, checks } = input;
  if (!state.finishPhase) return null;
  const spent = state.finishPhase.roundsUsed >= state.finishPhase.maxRounds;
  const failed = checks.some((check) => check.result === 'failed');
  const notes = checks.some((check) => check.result !== 'passed');
  if ((!clean || failed) && !spent) return null;
  const kind = failed || (isStrictReviewDrivenLoop(state.config) && notes)
    ? 'needs-sign-off' : notes || !clean ? 'completed-with-notes' : 'completed';
  const details = checks.map((check) => `${check.check}: ${check.detail}`).join('\n');
  const reason = kind === 'completed' ? 'Finished after a clean finish round and the checks passed.'
    : kind === 'needs-sign-off'
      ? 'Finish checks need your sign-off. Accept re-runs the full check. If it fails again, use Resume (3 more finish rounds) or Stop.'
      : `Ended with notes. The task list was closed at round ${state.finishPhase.enteredAtSeq + 1}.`;
  return { kind, reason: `${reason}\n${details}`, checks };
}

export function stageFinishEvidence(state: LoopState, checks: FinishCheck[]): void {
  state.endEvidence = { ...state.endEvidence, finishChecks: checks,
    mergeHold: checks.some((check) => check.result === 'skipped' || check.result === 'failed') };
}
