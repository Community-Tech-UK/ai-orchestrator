import type {
  LoopFinalAuditResult,
  LoopIteration,
  LoopState,
  ProgressSignalEvidence,
} from '../../shared/types/loop.types';
import { buildFinalAuditIntervention, runLoopFinalAudit } from './loop-audit-runtime';
import { applyLoopPhaseRecovery } from './loop-phase-recovery';
import type { LoopStageMachine } from './loop-stage-machine';

type ClaimedDoneFailedPayload = {
  loopRunId: string;
  signal: string;
  failure: string;
};

type CompletedNeedsReviewPayload = {
  loopRunId: string;
  reason: string;
  acceptedByOperator: false;
};

export async function handleLoopFinalAuditBlockedCompletion(params: {
  state: LoopState;
  iteration: LoopIteration | undefined;
  finalAudit: LoopFinalAuditResult;
  stageMachine: LoopStageMachine;
  signal: string;
  rejectPendingCompleteIntent: (state: LoopState, reason: string) => void;
  rejectCompletionAttempt: (state: LoopState, reason: string, intervention: string) => void;
  setConvergenceNote: (loopRunId: string, note: string) => void;
  emitClaimedDoneButFailed: (payload: ClaimedDoneFailedPayload) => void;
  emitCompletedNeedsReview: (payload: CompletedNeedsReviewPayload) => void;
  terminate: (state: LoopState, status: LoopState['status'], reason: string) => void;
}): Promise<'continue' | 'terminal'> {
  const { state, iteration, finalAudit, stageMachine, signal } = params;
  state.lastCompletionOutcome = 'review-blocked';
  const recovery = await applyLoopPhaseRecovery({
    state,
    iteration,
    finalAudit,
    stageMachine,
  });

  if (recovery.status === 'handoff') {
    const terminalStatus = recovery.terminalStatus ?? 'no-progress';
    const reason = recovery.reason ?? 'final audit blocked completion repeatedly';
    params.rejectPendingCompleteIntent(state, 'final audit phase recovery handoff');
    if (terminalStatus === 'completed-needs-review') {
      params.emitCompletedNeedsReview({
        loopRunId: state.id,
        reason,
        acceptedByOperator: false,
      });
    }
    params.terminate(state, terminalStatus, reason);
    return 'terminal';
  }

  if (recovery.fixSpecPath) {
    const failure = `Final audit blocked completion. Phase recovery wrote a narrow fix spec: ${recovery.fixSpecPath}`;
    params.rejectPendingCompleteIntent(state, 'final audit phase recovery fix spec required');
    params.setConvergenceNote(state.id, 'final audit phase recovery fix spec required');
    params.emitClaimedDoneButFailed({ loopRunId: state.id, signal, failure });
    return 'continue';
  }

  const intervention = buildFinalAuditIntervention(finalAudit);
  params.rejectCompletionAttempt(state, 'final audit blocked completion', intervention);
  params.emitClaimedDoneButFailed({ loopRunId: state.id, signal, failure: intervention });
  return 'continue';
}

export async function handleVerifiedNoChangeReviewDrivenCompletion(params: {
  state: LoopState;
  iteration: LoopIteration;
  stageMachine: LoopStageMachine;
  primary?: ProgressSignalEvidence;
  handleBlockedCompletion: (args: {
    state: LoopState;
    iteration: LoopIteration;
    finalAudit: LoopFinalAuditResult;
    stageMachine: LoopStageMachine;
    signal: string;
  }) => Promise<'continue' | 'terminal'>;
  emitCompletedNeedsReview: (payload: CompletedNeedsReviewPayload) => void;
  terminate: (state: LoopState, status: 'completed-needs-review', reason: string) => void;
}): Promise<'continue' | 'terminal'> {
  const { state, iteration, stageMachine, primary } = params;
  const finalAudit = await runLoopFinalAudit(
    state,
    iteration,
    iteration.verifyStatus === 'passed'
      ? 'passed'
      : iteration.verifyStatus === 'failed'
        ? 'failed'
        : 'skipped',
    stageMachine,
  );
  if (state.config.audit.finalAuditMode === 'gate' && finalAudit.status === 'failed') {
    return params.handleBlockedCompletion({
      state,
      iteration,
      finalAudit,
      stageMachine,
      signal: 'self-declared',
    });
  }
  const reason = verifiedNoChangeReviewDrivenReason(state, finalAudit, primary);
  state.lastCompletionOutcome = 'accepted';
  params.emitCompletedNeedsReview({
    loopRunId: state.id,
    reason,
    acceptedByOperator: false,
  });
  params.terminate(state, 'completed-needs-review', reason);
  return 'terminal';
}

function verifiedNoChangeReviewDrivenReason(
  state: LoopState,
  finalAudit: LoopFinalAuditResult,
  primary: ProgressSignalEvidence | undefined,
): string {
  if (state.config.audit.finalAuditMode === 'gate' && finalAudit.status === 'needs-review') {
    return 'Final audit requires operator review before this loop can be considered cleanly complete.';
  }
  return `Review-driven loop reached a verified completion with no production changes ` +
    `after a repeated-work CRITICAL signal` +
    (primary ? ` (${primary.message})` : '') +
    `. Stopped for human review instead of treating the settled no-change state as a stall.`;
}
